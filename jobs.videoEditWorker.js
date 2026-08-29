/**
 * Runs a Video Editor job: download (any platform via yt-dlp) -> apply the
 * user's selected effects as a sequence of ffmpeg passes -> save to Drive
 * (or keep locally) -> mark completed/failed. No credits are charged - this
 * is local ffmpeg processing, not a paid Google API call.
 */
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const env = require('./config.env');
const logger = require('./utils.logger');
const VideoEditJob = require('./models.VideoEditJob');
const videoDownloadService = require('./services.videoDownloadService');
const transcribeDubService = require('./services.transcribeDubService');
const geminiService = require('./services.geminiService');
const { reorderTitleWords, sanitizeForFilename } = require('./utils.titleFallback');
const driveService = require('./services.googleDriveService');
const effects = require('./utils.videoEffects');
const autoHighlight = require('./utils.autoHighlight');
const ffmpeg = require('./utils.ffmpeg');
const Log = require('./models.Log');
const { notifyUploadEvent } = require('./services.notificationService');

const EXEC_OPTS = { timeout: 15 * 60 * 1000, maxBuffer: 1024 * 1024 * 50 };

// Same memory-safe encode settings that fixed the TikTok downloader's OOM
// issue - low thread count + limited x264 lookahead keeps peak memory well
// under control, and veryfast/crf20 keeps CPU time reasonable too. Used on
// every pass below that re-encodes video (not needed where -c:v copy applies).
const SAFE_VIDEO_ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', '2', '-x264-params', 'rc-lookahead=20:ref=2'];

async function runFfmpeg(args) {
  try {
    await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', ...args], EXEC_OPTS);
  } catch (err) {
    // execFileAsync's rejection normally only surfaces "Command failed: <cmd>"
    // in err.message, silently dropping ffmpeg's actual stderr explanation
    // (e.g. "Filter graph too complex", a bad filter argument, etc.) - attach
    // it so failures are actually diagnosable instead of just "it failed".
    const stderr = (err.stderr || '').toString().trim();
    if (stderr) err.message = `${err.message}\nffmpeg stderr: ${stderr.slice(0, 2000)}`;
    throw err;
  }
}

async function processVideoEditJob(job, { regenerateMetadata = false } = {}) {
  const tempFiles = [];
  let current;
  let finalTitle = null; // used for the Drive filename - see title regeneration block below
  try {
    const spec = typeof job.effects_json === 'string' ? JSON.parse(job.effects_json) : job.effects_json || {};

    await VideoEditJob.setStatus(job.id, 'downloading');
    logger.info(`[video-edit] job ${job.id}: downloading source`);
    current = path.join(env.upload.tempDir, `${job.id}_0_source.mp4`);
    await videoDownloadService.downloadVideo(job.source_url, current);
    tempFiles.push(current);
    logger.info(`[video-edit] job ${job.id}: source downloaded`);

    // Optional: regenerate the source video's original title/description (any
    // language) into a catchy English title + hashtags. Never fails the whole
    // job - falls back to the original title (reordered, see
    // utils.titleFallback) if AI regeneration is off, or if it's on but
    // fails for any reason (e.g. quota). Either way `finalTitle` ends up
    // holding whatever we should actually name the Drive file after,
    // instead of the old generic "edited_<jobId>.mp4".
    if (regenerateMetadata) {
      await VideoEditJob.setStatus(job.id, 'regenerating_metadata');
      const meta = await videoDownloadService.getMetadata(job.source_url).catch((err) => {
        logger.error(`[video-edit] could not fetch source metadata for job ${job.id}, skipping title regeneration: ${err.message}`);
        return null;
      });
      if (meta) {
        try {
          const regenerated = await geminiService.regenerateTitleAndHashtags(meta.title, meta.description);
          finalTitle = regenerated.title;
          await VideoEditJob.setGeneratedMetadata(job.id, { generatedTitle: regenerated.title, generatedHashtags: regenerated.hashtags });
        } catch (metaErr) {
          logger.error(`[video-edit] title regeneration failed for job ${job.id}, falling back to reordered original title: ${metaErr.message}`);
          await Log.record(job.user_id, 'Video Edit Title Regeneration Failed', { sourceUrl: job.source_url, jobId: job.id, error: metaErr.message }, 'error');
          finalTitle = reorderTitleWords(meta.title);
          if (finalTitle) {
            await VideoEditJob.setGeneratedMetadata(job.id, { generatedTitle: finalTitle, generatedHashtags: null });
          }
        }
      }
    }

    // 0. Transcribe & Dub (runs first, before any other effects, so later
    //    steps operate on the already-dubbed video). Uses the self-hosted
    //    transcribe-dub API: transcribes the original audio -> translates it
    //    -> generates new speech in the target language via Kokoro -> we mux
    //    that new audio onto the video here, replacing the original track.
    if (spec.dubTargetLanguage) {
      logger.info(`[video-edit] job ${job.id}: transcribing + dubbing into ${spec.dubTargetLanguage}`);
      await VideoEditJob.setStatus(job.id, 'dubbing');
      const dubbedAudioPath = path.join(env.upload.tempDir, `${job.id}_dubbed_audio.wav`);
      await transcribeDubService.dubVideo(current, dubbedAudioPath, spec.dubTargetLanguage, spec.dubSourceLanguage || null);
      tempFiles.push(dubbedAudioPath);

      const out = path.join(env.upload.tempDir, `${job.id}_0_dubbed.mp4`);
      await runFfmpeg(['-i', current, '-i', dubbedAudioPath, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-shortest', out]);
      current = out;
      tempFiles.push(out);
      logger.info(`[video-edit] job ${job.id}: dubbing done`);
    }

    let secondaryPath = null;
    if (job.secondary_url && spec.splitScreen) {
      logger.info(`[video-edit] job ${job.id}: downloading secondary (split-screen) video`);
      secondaryPath = path.join(env.upload.tempDir, `${job.id}_secondary.mp4`);
      await videoDownloadService.downloadVideo(job.secondary_url, secondaryPath);
      tempFiles.push(secondaryPath);
    }

    await VideoEditJob.setStatus(job.id, 'editing');
    let step = 1;
    const next = () => path.join(env.upload.tempDir, `${job.id}_${step++}.mp4`);

    // 0. Auto-Highlight (non-AI): shortens the video to a target length by
    // keeping the loudest/most active segments and cutting quieter stretches.
    if (spec.autoHighlightMinutes) {
      logger.info(`[video-edit] job ${job.id}: auto-highlight - analyzing audio`);
      const sourceDuration = await ffmpeg.getMediaDuration(current);
      const targetSeconds = Math.max(10, Number(spec.autoHighlightMinutes) * 60);
      if (targetSeconds < sourceDuration) {
        const loudSegments = await autoHighlight.detectLoudSegments(current, sourceDuration);
        const selected = autoHighlight.selectSegments(loudSegments, targetSeconds);
        if (selected.length) {
          logger.info(`[video-edit] job ${job.id}: auto-highlight - keeping ${selected.length} segment(s)`);
          const out = next();
          const filterComplex = autoHighlight.buildTrimConcatFilter(selected);
          await runFfmpeg(['-i', current, '-filter_complex', filterComplex, '-map', '[outv]', '-map', '[outa]', ...SAFE_VIDEO_ENCODE, '-c:a', 'aac', out]);
          current = out;
          tempFiles.push(out);
          logger.info(`[video-edit] job ${job.id}: auto-highlight done`);
        } else {
          logger.info(`[video-edit] job ${job.id}: auto-highlight - no segments found, skipping`);
        }
      } else {
        logger.info(`[video-edit] job ${job.id}: auto-highlight - source already at/under target length, skipping`);
      }
    }

    // 1. Split screen (combines two videos into one before any other effect)
    if (secondaryPath && spec.splitScreen) {
      logger.info(`[video-edit] job ${job.id}: applying split-screen (${spec.splitScreen})`);
      const out = next();
      const mode = spec.splitScreen;
      let filterComplex;
      if (mode === 'top_bottom') {
        filterComplex = '[0:v]scale=1080:960[top];[1:v]scale=1080:960[bottom];[top][bottom]vstack=inputs=2[outv]';
      } else if (mode === 'pip') {
        filterComplex = '[1:v]scale=360:-1[pip];[0:v][pip]overlay=W-w-30:H-h-30[outv]';
      } else {
        filterComplex = '[0:v]scale=540:960[left];[1:v]scale=540:960[right];[left][right]hstack=inputs=2[outv]';
      }
      await runFfmpeg(['-i', current, '-i', secondaryPath, '-filter_complex', filterComplex, '-map', '[outv]', '-map', '0:a', ...SAFE_VIDEO_ENCODE, '-c:a', 'copy', out]);
      current = out;
      tempFiles.push(out);
      logger.info(`[video-edit] job ${job.id}: split-screen done`);
    }

    // 2. Simple -vf effects combined into one pass: color grade, point-effects
    //    (excluding light leak, which needs a second input), beat sync, B&W.
    const simpleFilters = [];
    if (spec.colorGrade && effects.COLOR_GRADE_FILTERS[spec.colorGrade]) {
      simpleFilters.push(effects.COLOR_GRADE_FILTERS[spec.colorGrade]);
    }
    // Effect cues: each one is its own {effect, at} pair, so different
    // effects can fire at different timestamps (e.g. flash at 4s, jump cut
    // at 6s, slide at 10s) instead of everything sharing one timestamp.
    // Backward-compatible with the older pointEffects[] + effectAt shape.
    const manualCues = Array.isArray(spec.effectCues) && spec.effectCues.length
      ? spec.effectCues
      : (spec.pointEffects || []).map((effect) => ({ effect, at: Number(spec.effectAt) || 2 }));

    // Auto-loop: cycles through the selected effects at a fixed interval
    // across the video's actual full length, instead of the user placing
    // each one manually. Can be combined with manual cues above.
    let autoLoopCues = [];
    if (Array.isArray(spec.autoLoopEffects) && spec.autoLoopEffects.length) {
      const interval = Math.max(1, Number(spec.autoLoopIntervalSeconds) || 5);
      const duration = await ffmpeg.getMediaDuration(current);
      let i = 0;
      for (let t = interval; t < duration - 0.3; t += interval) {
        autoLoopCues.push({ effect: spec.autoLoopEffects[i % spec.autoLoopEffects.length], at: t });
        i += 1;
      }
      logger.info(`[video-edit] job ${job.id}: auto-loop generated ${autoLoopCues.length} cues over ${duration.toFixed(1)}s (every ${interval}s)`);
    }

    const cues = [...manualCues, ...autoLoopCues];
    cues.forEach(({ effect, at }) => {
      const filter = effects.pointEffectFilter(effect, Number(at) || 2);
      if (filter) simpleFilters.push(filter);
    });
    if (spec.beatSyncBpm) simpleFilters.push(effects.beatSyncFilter(Number(spec.beatSyncBpm)));
    if (spec.blackAndWhite) simpleFilters.push('hue=s=0');

    if (simpleFilters.length) {
      logger.info(`[video-edit] job ${job.id}: applying color grade/point-effects/B&W pass`);
      const out = next();
      await runFfmpeg(['-i', current, '-vf', simpleFilters.join(','), ...SAFE_VIDEO_ENCODE, '-c:a', 'copy', out]);
      current = out;
      tempFiles.push(out);
      logger.info(`[video-edit] job ${job.id}: color grade/point-effects/B&W pass done`);
    }

    // 4. Freeze frame
    if (spec.freezeFrameAt != null) {
      logger.info(`[video-edit] job ${job.id}: applying freeze frame`);
      const t = Number(spec.freezeFrameAt);
      const dur = Number(spec.freezeFrameDuration) || 1;
      const framePng = path.join(env.upload.tempDir, `${job.id}_freeze_frame.png`);
      await runFfmpeg(['-ss', String(t), '-i', current, '-vframes', '1', framePng]);
      tempFiles.push(framePng);
      const out = next();
      await runFfmpeg([
        '-i', current, '-i', framePng,
        '-filter_complex',
        `[0:v]trim=0:${t},setpts=PTS-STARTPTS[v1];` +
          `[1:v]loop=loop=${Math.round(dur * 25)}:size=1,setpts=N/25/TB,format=yuv420p[v2];` +
          `[0:v]trim=${t},setpts=PTS-STARTPTS[v3];` +
          `[v1][v2][v3]concat=n=3:v=1:a=0[outv]`,
        '-map', '[outv]', '-map', '0:a', ...SAFE_VIDEO_ENCODE, '-c:a', 'copy', out,
      ]);
      current = out;
      tempFiles.push(out);
      logger.info(`[video-edit] job ${job.id}: freeze frame done`);
    }

    // 5. Vertical conversion (9:16, blurred-background pad, statically centered)
    if (spec.verticalConvert) {
      logger.info(`[video-edit] job ${job.id}: applying vertical conversion`);
      const out = next();
      await runFfmpeg(['-i', current, '-filter_complex', effects.verticalConversionFilterComplex(), '-map', '[outv]', '-map', '0:a', ...SAFE_VIDEO_ENCODE, '-c:a', 'copy', out]);
      current = out;
      tempFiles.push(out);
      logger.info(`[video-edit] job ${job.id}: vertical conversion done`);
    }

    // 6. Speed ramping (affects both video and audio)
    if (spec.speedFactor && Number(spec.speedFactor) !== 1) {
      logger.info(`[video-edit] job ${job.id}: applying speed ramp (${spec.speedFactor}x)`);
      const { videoFilter, audioFilter } = effects.speedFilters(Number(spec.speedFactor));
      const out = next();
      await runFfmpeg(['-i', current, '-vf', videoFilter, '-af', audioFilter, ...SAFE_VIDEO_ENCODE, out]);
      current = out;
      tempFiles.push(out);
      logger.info(`[video-edit] job ${job.id}: speed ramp done`);
    }

    // 7. Vine boom (synthesized bass hit mixed into the audio at a timestamp)
    if (spec.vineBoomAt != null) {
      logger.info(`[video-edit] job ${job.id}: applying vine boom`);
      const boomPath = path.join(env.upload.tempDir, `${job.id}_boom.wav`);
      await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=60:duration=0.6', '-af', 'afade=t=out:st=0.1:d=0.5,volume=8', boomPath]);
      tempFiles.push(boomPath);
      const delayMs = Math.round(Number(spec.vineBoomAt) * 1000);
      const out = next();
      await runFfmpeg([
        '-i', current, '-i', boomPath,
        '-filter_complex', `[1:a]adelay=${delayMs}|${delayMs}[boom];[0:a][boom]amix=inputs=2:duration=first[outa]`,
        '-map', '0:v', '-map', '[outa]', '-c:v', 'copy', out,
      ]);
      current = out;
      tempFiles.push(out);
    }

    // Final result is `current` - encode it losslessly if it's still just a
    // copy of the source container (rare edge case: no effects selected).
    const finalOutput = path.join(env.upload.tempDir, `${job.id}_final.mp4`);
    fs.copyFileSync(current, finalOutput);

    // Prefer the AI-generated title, or (if that failed/was skipped) the
    // reordered-original-title fallback set above. Only drop back to the
    // generic "edited_<jobId>.mp4" name if we truly have no title at all
    // (e.g. regenerateMetadata was off and no fallback was ever computed).
    const titleSlug = sanitizeForFilename(finalTitle);
    const fileName = titleSlug ? `${titleSlug}_${job.id.slice(0, 8)}.mp4` : `edited_${job.id.slice(0, 8)}.mp4`;
    if (job.drive_folder_id) {
      const uploaded = await driveService.uploadFile(job.user_id, job.drive_folder_id, finalOutput, fileName);
      await VideoEditJob.markCompleted(job.id, { driveFileId: uploaded.id, driveFileName: uploaded.name });
      await Log.record(job.user_id, 'Video Edited', { sourceUrl: job.source_url, driveFileName: uploaded.name });
      await notifyUploadEvent(job.user_id, { type: 'success', videoName: uploaded.name, pageName: 'Video Editor' });
      fs.unlink(finalOutput, () => {});
    } else {
      const localPath = path.join(env.upload.tempDir, `${job.id}_local_${fileName}`);
      fs.renameSync(finalOutput, localPath);
      await VideoEditJob.markCompleted(job.id, { localFilePath: localPath, driveFileName: fileName });
      await Log.record(job.user_id, 'Video Edited', { sourceUrl: job.source_url, driveFileName: fileName, note: 'Not saved to Drive' });
      await notifyUploadEvent(job.user_id, { type: 'success', videoName: fileName, pageName: 'Video Editor' });
    }
    logger.info(`[video-edit] completed job ${job.id}`);
  } catch (err) {
    logger.error(`[video-edit] failed job ${job.id}: ${err.message}`);
    await VideoEditJob.markFailed(job.id, err.message);
    await Log.record(job.user_id, 'Video Edit Failed', { sourceUrl: job.source_url, error: err.message }, 'error');
  } finally {
    tempFiles.forEach(driveService.deleteTempFile);
  }
}

// Sequential in-memory queue - video editing is CPU/memory heavy (multiple
// ffmpeg passes), so jobs run one at a time rather than all at once.
const queue = [];
let draining = false;

function enqueueVideoEditJob(job, options = {}) {
  queue.push({ job, options });
  drainQueue();
}

async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const { job, options } = queue.shift();
      try {
        await processVideoEditJob(job, options);
      } catch (err) {
        logger.error(`[video-edit] queued job ${job.id} threw unexpectedly: ${err.message}`);
      }
    }
  } finally {
    draining = false;
  }
}

module.exports = { processVideoEditJob, enqueueVideoEditJob };
