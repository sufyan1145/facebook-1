/**
 * Video Editor "Make clips from a long video".
 *
 * One batch job = download the source once, cut the NEXT n clips (continuing
 * from where the previous batch for the same video ended), save each clip to
 * Drive (or keep it locally) and add it to the history as its own completed
 * entry. The cursor is advanced after every single clip, so:
 *   - a part that was already made is never made again,
 *   - if something fails half-way, the finished clips are kept and the next
 *     run continues from the first clip that is still missing.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const env = require('./config.env');
const logger = require('./utils.logger');
const VideoEditJob = require('./models.VideoEditJob');
const VideoClipProgress = require('./models.VideoClipProgress');
const videoDownloadService = require('./services.videoDownloadService');
const driveService = require('./services.googleDriveService');
const ffmpeg = require('./utils.ffmpeg');
const Log = require('./models.Log');
const { notifyUploadEvent } = require('./services.notificationService');
const { sanitizeForFilename } = require('./utils.titleFallback');
const splitter = require('./utils.clipSplitter');

// Same memory-safe encode settings the rest of the editor uses.
const SAFE_VIDEO_ENCODE = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-threads', '0', '-x264-params', 'rc-lookahead=0:ref=1'];

async function cutClip(source, start, length, out) {
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-nostats',
    '-ss', String(start), '-i', source, '-t', String(length),
    '-map', '0:v:0', '-map', '0:a:0?',
    ...SAFE_VIDEO_ENCODE, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    out,
  ];
  try {
    await execFileAsync('ffmpeg', args, { timeout: 0, maxBuffer: 1024 * 1024 * 50 });
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    if (stderr) err.message = `${err.message}\nffmpeg stderr: ${stderr.slice(-800)}`;
    throw err;
  }
}

function clipTitle(sourceTitle, partNo) {
  const base = sourceTitle ? `${String(sourceTitle).trim().slice(0, 90)} - Part ${partNo}` : `Part ${partNo}`;
  return base;
}

async function finishBatch(job, { made, firstPart, lastPart, fromSec, toSec, total }) {
  let summary;
  if (!made) {
    summary = 'Nothing new to make: every part of this video was already created. Use "Reset" to start again from the beginning.';
  } else {
    const done = splitter.isFinished(toSec, total);
    summary = `${made} clip${made === 1 ? '' : 's'} created: Part ${firstPart}${lastPart !== firstPart ? `-${lastPart}` : ''} (${splitter.fmtTime(fromSec)}-${splitter.fmtTime(toSec)} of ${splitter.fmtTime(total)}). ` +
      (done ? 'The whole video is done.' : `${splitter.fmtTime(total - toSec)} left - make clips again to continue from ${splitter.fmtTime(toSec)}.`);
  }
  await VideoEditJob.setClipSummary(job.id, summary);
  await VideoEditJob.markCompleted(job.id, {});
  await Log.record(job.user_id, 'Video Clips Created', { sourceUrl: job.source_url, jobId: job.id, clips: made });
  if (made) {
    await notifyUploadEvent(job.user_id, { type: 'success', videoName: `${made} clip${made === 1 ? '' : 's'}`, pageName: 'Video Editor' });
  }
  logger.info(`[video-clips] job ${job.id}: ${summary}`);
}

async function processClipJob(job, clipSpec) {
  const tempFiles = [];
  try {
    const key = clipSpec.sourceKey || splitter.normalizeSourceKey(job.source_url);
    const cap = job.drive_folder_id ? splitter.MAX_CLIPS_DRIVE : splitter.MAX_CLIPS_LOCAL;
    let progress = await VideoClipProgress.getOrCreate(job.user_id, key, job.source_url);

    // Everything already made? Answer without downloading anything.
    if (progress.source_duration && splitter.isFinished(progress.next_start, progress.source_duration)) {
      await finishBatch(job, { made: 0, total: Number(progress.source_duration) });
      return;
    }

    await VideoEditJob.setStatus(job.id, 'downloading');
    const source = path.join(env.upload.tempDir, `${job.id}_0_source.mp4`);
    await videoDownloadService.downloadVideo(job.source_url, source);
    tempFiles.push(source);
    const total = await ffmpeg.getMediaDuration(source);

    let title = progress.source_title;
    if (!title) {
      const meta = await videoDownloadService.getMetadata(job.source_url).catch(() => null);
      title = (meta && meta.title) || null;
    }
    await VideoClipProgress.setSourceInfo(progress.id, { duration: total, title });

    const plan = splitter.planClips({
      start: Number(progress.next_start),
      total,
      clipSeconds: clipSpec.clipSeconds,
      maxClips: clipSpec.maxClips,
      hardCap: cap,
    });
    if (!plan.clips.length) {
      await finishBatch(job, { made: 0, total });
      return;
    }

    await VideoEditJob.setStatus(job.id, 'splitting');
    const titleSlug = sanitizeForFilename(title, 60);
    const firstPart = progress.parts_made + 1;
    const parentCreated = new Date(job.created_at).getTime();
    let made = 0;
    let lastEnd = Number(progress.next_start);

    for (const c of plan.clips) {
      const partNo = firstPart + made;
      await VideoEditJob.setClipSummary(job.id, `Making part ${partNo} (${made + 1} of ${plan.clips.length})...`);
      const out = path.join(env.upload.tempDir, `${job.id}_clip_${partNo}.mp4`);
      tempFiles.push(out);
      try {
        await cutClip(source, c.start, c.length, out);

        const childId = crypto.randomUUID();
        const fileName = `${titleSlug || 'clip'}_part${String(partNo).padStart(2, '0')}_${job.id.slice(0, 8)}.mp4`;
        let driveFileId = null;
        let driveFileName = fileName;
        let localPath = null;
        if (job.drive_folder_id) {
          const uploaded = await driveService.uploadFile(job.user_id, job.drive_folder_id, out, fileName);
          driveFileId = uploaded.id;
          driveFileName = uploaded.name;
          fs.unlink(out, () => {});
        } else {
          localPath = path.join(env.upload.tempDir, `${childId}_local_${fileName}`);
          fs.renameSync(out, localPath);
        }

        await VideoEditJob.createClipChild(job, {
          id: childId,
          driveFileId,
          driveFileName,
          localFilePath: localPath,
          generatedTitle: clipTitle(title, partNo),
          clipInfo: { part: partNo, startSec: c.start, endSec: round(c.start + c.length), clipSeconds: clipSpec.clipSeconds },
          // keeps the history in Part 1, 2, 3... order under the batch row
          createdAt: new Date(parentCreated - (made + 1) * 1000),
        });
        // Only now is the part "made" for good.
        lastEnd = round(c.start + c.length);
        await VideoClipProgress.advance(progress.id, lastEnd);
        made += 1;
      } catch (err) {
        err.message = `Part ${partNo} failed: ${err.message}` +
          (made ? ` (${made} clip${made === 1 ? ' was' : 's were'} already saved - make clips again to continue from part ${partNo})` : '');
        throw err;
      }
    }

    await finishBatch(job, {
      made, firstPart, lastPart: firstPart + made - 1,
      fromSec: Number(progress.next_start), toSec: lastEnd, total,
    });
  } finally {
    tempFiles.forEach(driveService.deleteTempFile);
  }
}

function round(n) { return Math.round(n * 1000) / 1000; }

module.exports = { processClipJob };
