const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./utils.logger');

// Default timeout is fine for fast steps (concat/copy/trim), but subtitle
// burn-in re-encodes every frame through libx264 + the subtitles filter and
// can run well under 1x realtime speed on modest hardware. A fixed 120s cap
// was killing ffmpeg mid-encode (Node sends SIGTERM on timeout, which ffmpeg
// then exits from with code 255) on videos that were only a few seconds too
// slow to finish in time - so callers can now opt into a longer timeout.
function run(args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 1024 * 1024 * 50, timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        const detail = stderr?.slice(-2000) || '(no stderr output)';
        logger.error(`[ffmpeg] failed: code=${err.code} signal=${err.signal} message=${err.message} | stderr tail: ${detail}`);
        return reject(new Error(`ffmpeg failed (code=${err.code}, signal=${err.signal}): ${err.message}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

// Concatenates video clips (same codec/resolution expected) into one file.
async function concatClips(clipPaths, outputPath) {
  const listPath = outputPath.replace(/\.mp4$/, '.txt');
  const listContent = clipPaths.map((p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listPath, listContent);

  // Re-encodes the whole video (not a stream copy), same as burnCaptions below -
  // needs the same generous timeout so longer/multi-scene videos don't get
  // killed mid-encode (see burnCaptions comment for the full explanation).
  await run(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '3', '-an', outputPath], 900000);
  fs.unlinkSync(listPath);
  return outputPath;
}

// Lays the voiceover audio track over the stitched video, trimming to the shorter of the two.
async function mergeAudioVideo(videoPath, audioPath, outputPath) {
  await run([
    '-y', '-i', videoPath, '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-shortest', outputPath,
  ]);
  return outputPath;
}

// Converts raw 16-bit PCM audio (24kHz mono, Gemini TTS's raw output format) to MP3
async function pcmToMp3(pcmPath, mp3Path) {
  await run(['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath, mp3Path]);
  return mp3Path;
}

// Builds the -vf filter chain for a given motion effect. All effects render at
// the same output size and always end with a short fade-in/fade-out so cuts
// between scenes feel like transitions instead of hard jumps.
function buildKenBurnsFilter(effect, width, height, durationSeconds, fps) {
  const frames = Math.max(1, Math.round(durationSeconds * fps));
  const maxZoom = 1.15;
  const zoomStep = ((maxZoom - 1) / frames).toFixed(8);
  const baseScale = `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width * 2}:${height * 2}`;

  let zoompanExpr;
  switch (effect) {
    case 'zoom_out':
      // Starts already zoomed in, eases back out to normal over the clip.
      zoompanExpr = `zoompan=z='if(lte(on,1),${maxZoom},max(1.0,zoom-${zoomStep}))':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
      break;
    case 'pan_left':
      // Slide effect: fixed moderate zoom, camera drifts from right edge to left edge.
      zoompanExpr = `zoompan=z='${maxZoom}':d=${frames}:x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
      break;
    case 'pan_right':
      zoompanExpr = `zoompan=z='${maxZoom}':d=${frames}:x='(iw-iw/zoom)*(on/${frames})':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
      break;
    case 'pan_up':
      zoompanExpr = `zoompan=z='${maxZoom}':d=${frames}:x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/${frames})':s=${width}x${height}:fps=${fps}`;
      break;
    case 'pan_down':
      zoompanExpr = `zoompan=z='${maxZoom}':d=${frames}:x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(on/${frames})':s=${width}x${height}:fps=${fps}`;
      break;
    case 'popup': {
      // Quick pop/bounce into place in the first ~0.4s, then holds still.
      const popFrames = Math.max(1, Math.min(frames, Math.round(fps * 0.4)));
      zoompanExpr = `zoompan=z='if(lte(on,${popFrames}),0.88+0.17*(on/${popFrames}),1.0)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
      break;
    }
    case 'zoom_in':
    default:
      zoompanExpr = `zoompan=z='min(zoom+${zoomStep},${maxZoom})':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps}`;
  }

  // Fade duration scales down for very short clips so it never eats the whole clip.
  const fadeDur = Math.min(0.35, Math.max(0.12, durationSeconds * 0.12)).toFixed(2);
  const fadeOutStart = Math.max(0, durationSeconds - fadeDur).toFixed(2);

  return `${baseScale},${zoompanExpr},format=yuv420p,fade=t=in:st=0:d=${fadeDur},fade=t=out:st=${fadeOutStart}:d=${fadeDur}`;
}

// Turns a still image into a short video clip with a motion effect (zoom, pan/slide,
// or popup) plus fade-in/fade-out. Cheaper alternative to AI text-to-video: one AI
// image per scene instead of per-second video credits. `effect` cycles across scenes
// so the whole video doesn't look like the same repeated zoom.
async function imageToKenBurnsClip(imagePath, durationSeconds, outputPath, width = 1080, height = 1920, effect = 'zoom_in') {
  const fps = 25;
  const vf = buildKenBurnsFilter(effect, width, height, durationSeconds, fps);

  await run([
    '-y',
    '-loop', '1',
    '-i', imagePath,
    '-vf', vf,
    '-t', String(durationSeconds),
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-threads', '3',
    '-an',
    outputPath,
  ]);
  return outputPath;
}

// Trims/loops a downloaded stock clip to the exact target duration and scales/crops
// it to a consistent size (matching the other clips) so they can all be concatenated.
async function normalizeClip(inputPath, durationSeconds, outputPath, width = 1080, height = 1920) {
  await run([
    '-y',
    '-stream_loop', '-1',
    '-i', inputPath,
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=yuv420p`,
    '-r', '25',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '3',
    '-an',
    '-t', String(durationSeconds),
    outputPath,
  ]);
  return outputPath;
}


// Extracts a single still frame from the source video at the given timestamp -
// used as a "real photo" scene in the News Reaction builder instead of an AI
// image (e.g. to actually show the newsmaker's face at that moment).
async function extractFrame(sourcePath, atTimeSeconds, outputImagePath) {
  await run(['-y', '-ss', String(Math.max(0, atTimeSeconds)), '-i', sourcePath, '-vframes', '1', '-q:v', '2', outputImagePath]);
  return outputImagePath;
}

// Trims a short burst straight out of the source video (no looping, unlike
// normalizeClip) starting at `startTime`, scaled/cropped to match the other
// scenes so it concatenates cleanly. Video only (-an) - the News Reaction
// builder handles this scene's audio (narration + quiet original) separately
// via mixNarrationWithBackground below.
async function trimSilentClip(sourcePath, startTime, durationSeconds, outputPath, width = 1080, height = 1920) {
  await run([
    '-y',
    '-ss', String(Math.max(0, startTime)),
    '-i', sourcePath,
    '-t', String(durationSeconds),
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=yuv420p`,
    '-r', '25',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '3',
    '-an',
    outputPath,
  ]);
  return outputPath;
}

// Builds a single News Reaction scene's final audio: the narration voiceover
// on top, with a quiet ("halka") clip of the *original* source video's own
// audio underneath for the exact same window - so an "original clip burst"
// scene still feels like it's from the real clip, while the narration stays
// clearly audible on top. `backgroundVolume` is linear (0.15 = original
// audio at ~15% volume). Output is forced to 24kHz mono MP3 to exactly match
// the TTS services' own output format (see services.googleTtsService.js /
// utils.ffmpeg.js pcmToMp3), so it concatenates cleanly with plain-narration
// scenes via concatAudio's `-c copy`.
async function mixNarrationWithBackground(narrationPath, sourcePath, startTime, durationSeconds, outputPath, backgroundVolume = 0.15) {
  await run([
    '-y',
    '-i', narrationPath,
    '-ss', String(Math.max(0, startTime)), '-t', String(durationSeconds), '-i', sourcePath,
    '-filter_complex',
    `[1:a]volume=${backgroundVolume},atrim=0:${durationSeconds},apad=whole_dur=${durationSeconds}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
    '-map', '[aout]',
    '-ar', '24000', '-ac', '1',
    '-c:a', 'libmp3lame',
    outputPath,
  ]);
  return outputPath;
}

// Returns the duration (in seconds, float) of an audio/video file using ffprobe.
function getMediaDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
      (err, stdout) => {
        if (err) return reject(new Error(`ffprobe failed: ${err.message}`));
        const seconds = parseFloat(stdout.trim());
        if (!seconds || Number.isNaN(seconds)) return reject(new Error(`ffprobe returned no duration for ${filePath}`));
        resolve(seconds);
      }
    );
  });
}

// Samples evenly-spaced frames across the whole video in a single ffmpeg
// pass (much cheaper than calling extractFrame in a loop, which reopens/
// reseeks the source file once per frame). Frames are scaled down small
// (480px wide) since they're only meant to be read by Gemini for scene
// understanding, not shown to a human - keeps the base64 payload for
// services.vertexAiService.js's explainVideo() small even for a video with
// many sampled frames. Returns the sorted list of frame file paths written.
async function extractSampledFrames(sourcePath, outputDir, intervalSeconds, maxFrames) {
  fs.mkdirSync(outputDir, { recursive: true });
  await run([
    '-y', '-i', sourcePath,
    '-vf', `fps=1/${intervalSeconds},scale=480:-2`,
    '-frames:v', String(maxFrames),
    '-q:v', '4',
    path.join(outputDir, 'frame_%04d.jpg'),
  ], 180000);
  return fs.readdirSync(outputDir)
    .filter((f) => f.startsWith('frame_'))
    .sort()
    .map((f) => path.join(outputDir, f));
}

// Muxes a narration track onto a video so the two always end up the SAME
// length - unlike mergeAudioVideo above (which uses -shortest and truncates
// whichever track is shorter), this is built for services.vertexAiService.js
// buildExplainerVideo(), where the narration's length is only an estimate
// (Gemini is asked to write ~1 word per ~0.43s, but real TTS pacing varies)
// and cutting either track short would either lose part of the video or cut
// the narration off mid-sentence. Instead:
//   - narration shorter than video -> pad the narration with silence at the
//     end, so the full video still plays (just with silence after the
//     narration finishes)
//   - narration longer than video -> freeze the video's last frame for the
//     extra time, so the narration is never cut off
async function muxNarrationOverVideo(videoPath, narrationPath, outputPath) {
  const videoDuration = await getMediaDuration(videoPath);
  const narrationDuration = await getMediaDuration(narrationPath);

  if (narrationDuration <= videoDuration + 0.05) {
    await run([
      '-y', '-i', videoPath, '-i', narrationPath,
      '-filter_complex', `[1:a]apad=whole_dur=${videoDuration}[a]`,
      '-map', '0:v:0', '-map', '[a]',
      '-c:v', 'copy', '-c:a', 'aac', '-t', String(videoDuration),
      outputPath,
    ]);
  } else {
    const extendBy = narrationDuration - videoDuration;
    await run([
      '-y', '-i', videoPath, '-i', narrationPath,
      '-filter_complex', `[0:v]tpad=stop_mode=clone:stop_duration=${extendBy}[v]`,
      '-map', '[v]', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac',
      outputPath,
    ], 300000);
  }
  return outputPath;
}

// Concatenates per-scene voiceover audio files (same codec expected) into one track.
// Extracts just the original audio for a clip-burst block, at normal volume
// (no narration mixed in) - used when a clip block has no voiceover of its
// own and should just play as itself. Output format matches the TTS
// services' own output (24kHz mono mp3) so it concatenates cleanly with
// narration-only scenes via concatAudio's `-c copy`.
async function extractAudioSegment(sourcePath, startTime, durationSeconds, outputPath) {
  await run([
    '-y',
    '-ss', String(Math.max(0, startTime)), '-i', sourcePath,
    '-t', String(durationSeconds),
    '-ar', '24000', '-ac', '1',
    '-c:a', 'libmp3lame',
    outputPath,
  ]);
  return outputPath;
}

// Pulls just the audio track out of any video/audio file, downmixed to mono
// 16kHz MP3 at a modest bitrate. Used by the Vertex-based Transcribe & Dub
// flow (services.vertexAiService.js dubVideo) to shrink a full video down to
// a small audio-only file before it's base64-inlined into a Gemini
// generateContent request - a 10-minute video can be 100+ MB, but its
// speech-only audio at this rate is only a few MB, which keeps requests
// comfortably under Vertex's inline-request size ceiling. 16kHz mono is also
// exactly what speech-recognition models expect, so this doesn't cost any
// transcription accuracy versus shipping the original high-quality audio.
async function extractAudio(sourcePath, outputPath) {
  await run([
    '-y',
    '-i', sourcePath,
    '-vn',
    '-ar', '16000', '-ac', '1',
    '-c:a', 'libmp3lame', '-b:a', '48k',
    outputPath,
  ], 300000); // 5 min - just a stream extract/transcode, but give slow disks/long videos room
  return outputPath;
}

// Transcodes/copies an audio file into whatever container/codec its output
// extension implies (e.g. .mp3 -> .wav gets a real PCM transcode, not just a
// byte copy) - a small generic wrapper used where a caller needs "make this
// audio file into that exact output path" without caring about the specifics.
async function transcodeAudio(inputPath, outputPath) {
  await run(['-y', '-i', inputPath, outputPath]);
  return outputPath;
}

// Generates a silent audio track of the given length, matching the TTS
// services' own format (24kHz mono mp3) - used as a safety net when a
// clip-burst's source segment has no audio track at all (rare, but some
// downloaded clips have silent stretches with no audio stream present).
async function generateSilentAudio(durationSeconds, outputPath) {
  await run([
    '-y',
    '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
    '-t', String(durationSeconds),
    '-c:a', 'libmp3lame',
    outputPath,
  ]);
  return outputPath;
}

// Mutes a video's own audio entirely and replaces it with a background music
// track, looped if the track is shorter than the video and trimmed to the
// video's exact length either way (`-shortest` against the looped audio).
// Video stream is copied untouched (`-c:v copy`) - fast, and no quality loss
// since we're not touching the picture at all, only swapping the audio.
async function muteAndAddMusic(videoPath, musicPath, outputPath) {
  await run([
    '-y',
    '-i', videoPath,
    '-stream_loop', '-1', '-i', musicPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest',
    '-movflags', '+faststart',
    outputPath,
  ]);
  return outputPath;
}

// Generates a short synthetic "whoosh" transition sound (bandpassed noise
// burst with a fade in/out envelope) - fully self-contained, no external
// sound-effect files/library needed. Used at the start of each Product
// Explainer beat for a professional-ad-style transition feel.
async function generateWhooshSfx(outputPath) {
  await run([
    '-y',
    '-f', 'lavfi', '-i', 'anoisesrc=d=0.4:c=white:r=24000:a=0.6',
    '-af', 'bandpass=f=1500:width_type=h:w=2000,afade=t=in:d=0.05,afade=t=out:st=0.3:d=0.1',
    '-ac', '1',
    '-c:a', 'libmp3lame',
    outputPath,
  ]);
  return outputPath;
}

// Overlays a short SFX burst at the start of a narration track - the SFX
// naturally ends within the first fraction of a second, narration continues
// normally after. Output matches the narration's own length (`duration=first`).
async function mixNarrationWithSfx(narrationPath, sfxPath, outputPath, sfxVolume = 0.6) {
  await run([
    '-y',
    '-i', narrationPath,
    '-i', sfxPath,
    '-filter_complex',
    `[1:a]volume=${sfxVolume}[sfx];[0:a][sfx]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
    '-map', '[aout]',
    '-ar', '24000', '-ac', '1',
    '-c:a', 'libmp3lame',
    outputPath,
  ]);
  return outputPath;
}

async function concatAudio(audioPaths, outputPath) {
  const listPath = outputPath.replace(/\.mp3$/, '.txt');
  const listContent = audioPaths.map((p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listPath, listContent);

  await run(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath]);
  fs.unlinkSync(listPath);
  return outputPath;
}

// Burns pre-built .ass (Advanced SubStation) animated captions onto a video clip.
async function burnCaptions(inputPath, assPath, outputPath) {
  await run([
    '-y',
    '-i', inputPath,
    '-vf', `subtitles=${assPath.replace(/:/g, '\\:')}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '3',
    '-an',
    outputPath,
  ], 900000); // 15 minutes - subtitle burn-in re-encodes the whole video and can run below 1x realtime speed
  return outputPath;
}

module.exports = { concatClips, mergeAudioVideo, muxNarrationOverVideo, pcmToMp3, imageToKenBurnsClip, normalizeClip, getMediaDuration, concatAudio, burnCaptions, extractFrame, extractSampledFrames, trimSilentClip, mixNarrationWithBackground, extractAudioSegment, extractAudio, transcodeAudio, generateSilentAudio, muteAndAddMusic, generateWhooshSfx, mixNarrationWithSfx };
