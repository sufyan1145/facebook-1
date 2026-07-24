const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./utils.logger');

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 1024 * 1024 * 50, timeout: 120000 }, (err, stdout, stderr) => {
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

  await run(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2', '-an', outputPath]);
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

// Turns a still image into a short video clip with a slow zoom/pan (Ken Burns) effect.
// Cheaper alternative to AI text-to-video: one AI image per scene instead of per-second video credits.
async function imageToKenBurnsClip(imagePath, durationSeconds, outputPath, width = 1080, height = 1920) {
  const fps = 25;
  const frames = Math.max(1, Math.round(durationSeconds * fps));
  const maxZoom = 1.15; // slow, subtle zoom-in over the clip
  const zoomStep = ((maxZoom - 1) / frames).toFixed(8);

  await run([
    '-y',
    '-loop', '1',
    '-i', imagePath,
    '-vf',
    `scale=${width * 2}:${height * 2}:force_original_aspect_ratio=increase,crop=${width * 2}:${height * 2},` +
      `zoompan=z='min(zoom+${zoomStep},${maxZoom})':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=${fps},` +
      `format=yuv420p`,
    '-t', String(durationSeconds),
    '-r', String(fps),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2',
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
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '2',
    '-an',
    '-t', String(durationSeconds),
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

// Concatenates per-scene voiceover audio files (same codec expected) into one track.
async function concatAudio(audioPaths, outputPath) {
  const listPath = outputPath.replace(/\.mp3$/, '.txt');
  const listContent = audioPaths.map((p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listPath, listContent);

  await run(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath]);
  fs.unlinkSync(listPath);
  return outputPath;
}

module.exports = { concatClips, mergeAudioVideo, pcmToMp3, imageToKenBurnsClip, normalizeClip, getMediaDuration, concatAudio };
