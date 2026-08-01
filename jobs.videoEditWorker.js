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
const driveService = require('./services.googleDriveService');
const effects = require('./utils.videoEffects');
const Log = require('./models.Log');
const { notifyUploadEvent } = require('./services.notificationService');

const EXEC_OPTS = { timeout: 15 * 60 * 1000, maxBuffer: 1024 * 1024 * 50 };

// Same memory-safe encode settings that fixed the TikTok downloader's OOM
// issue - low thread count + limited x264 lookahead keeps peak memory well
// under control, and veryfast/crf20 keeps CPU time reasonable too. Used on
// every pass below that re-encodes video (not needed where -c:v copy applies).
const SAFE_VIDEO_ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', '2', '-x264-params', 'rc-lookahead=20:ref=2'];

async function runFfmpeg(args) {
  await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', ...args], EXEC_OPTS);
}

async function processVideoEditJob(job) {
  const tempFiles = [];
  let current;
  try {
    const spec = typeof job.effects_json === 'string' ? JSON.parse(job.effects_json) : job.effects_json || {};

    await VideoEditJob.setStatus(job.id, 'downloading');
    logger.info(`[video-edit] job ${job.id}: downloading source`);
    current = path.join(env.upload.tempDir, `${job.id}_0_source.mp4`);
    await videoDownloadService.downloadVideo(job.source_url, current);
    tempFiles.push(current);
    logger.info(`[video-edit] job ${job.id}: source downloaded`);

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
    const effectAt = Number(spec.effectAt) || 2;
    (spec.pointEffects || []).forEach((key) => {
      const filter = effects.pointEffectFilter(key, effectAt);
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

    const fileName = `edited_${job.id.slice(0, 8)}.mp4`;
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

function enqueueVideoEditJob(job) {
  queue.push(job);
  drainQueue();
}

async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        await processVideoEditJob(job);
      } catch (err) {
        logger.error(`[video-edit] queued job ${job.id} threw unexpectedly: ${err.message}`);
      }
    }
  } finally {
    draining = false;
  }
}

module.exports = { processVideoEditJob, enqueueVideoEditJob };
