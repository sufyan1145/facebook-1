const logger = require('./utils.logger');
const VideoEditJob = require('./models.VideoEditJob');
const videoDownloadService = require('./services.videoDownloadService');
const driveService = require('./services.googleDriveService');
const Log = require('./models.Log');
const { enqueueVideoEditJob } = require('./jobs.videoEditWorker');
const VideoClipProgress = require('./models.VideoClipProgress');
const clipSplitter = require('./utils.clipSplitter');

async function create(req, res, next) {
  try {
    const { url, secondaryUrl, effects, driveFolderId, driveFolderName, saveToDrive, regenerateMetadata } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'A video URL is required' });
    if (!videoDownloadService.isValidUrl(url)) {
      return res.status(400).json({ success: false, message: 'That does not look like a valid URL' });
    }
    if (secondaryUrl && !videoDownloadService.isValidUrl(secondaryUrl)) {
      return res.status(400).json({ success: false, message: 'The second video URL does not look valid' });
    }
    if (effects && effects.splitScreen && !secondaryUrl) {
      return res.status(400).json({ success: false, message: 'Split screen needs a second video URL' });
    }
    if (saveToDrive && !driveFolderId) {
      return res.status(400).json({ success: false, message: 'Please select a Drive folder, or turn off "Save to Google Drive"' });
    }

    // "Make clips from a long video" is its own mode: only the clip settings
    // are kept (other effects are ignored), and the same video can't have two
    // clip batches running at once (they would race for the same parts).
    let jobEffects = effects;
    let regen = !!regenerateMetadata;
    if (effects && effects.clipSplit && effects.clipSplit.enabled) {
      const v = clipSplitter.validateClipSpec(effects.clipSplit, { saveToDrive: !!saveToDrive });
      if (!v.ok) return res.status(400).json({ success: false, message: v.error });
      const sourceKey = clipSplitter.normalizeSourceKey(url);
      if (await VideoEditJob.hasActiveClipJob(req.user.id, sourceKey)) {
        return res.status(409).json({ success: false, message: 'Clips for this video are already being made. Please wait until that finishes.' });
      }
      jobEffects = { clipSplit: { enabled: true, clipSeconds: v.clipSeconds, maxClips: v.maxClips, sourceKey } };
      regen = false;
    }

    const job = await VideoEditJob.create(req.user.id, {
      sourceUrl: url,
      secondaryUrl: jobEffects && jobEffects.clipSplit ? null : secondaryUrl,
      effects: jobEffects,
      driveFolderId: saveToDrive ? driveFolderId : null,
      driveFolderName: saveToDrive ? driveFolderName : null,
    });

    enqueueVideoEditJob(job, { regenerateMetadata: regen });
    await Log.record(req.user.id, 'Video Edit Started', { sourceUrl: url, jobId: job.id });
    res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
}

async function listJobs(req, res, next) {
  try {
    // 150 (was 50): one clip batch can add many entries at once.
    const jobs = await VideoEditJob.listByUser(req.user.id, 150);
    res.json({ success: true, data: jobs });
  } catch (err) {
    next(err);
  }
}

// ---- Clip progress for a video (how far clips have been cut) -------------
async function clipProgress(req, res, next) {
  try {
    const url = String(req.query.url || '').trim();
    if (!url || !videoDownloadService.isValidUrl(url)) return res.json({ success: true, data: null });
    const key = clipSplitter.normalizeSourceKey(url);
    const p = await VideoClipProgress.get(req.user.id, key);
    if (!p) return res.json({ success: true, data: null });
    const total = p.source_duration != null ? Number(p.source_duration) : null;
    res.json({
      success: true,
      data: {
        partsMade: p.parts_made,
        nextStart: Number(p.next_start),
        sourceDuration: total,
        finished: total != null && clipSplitter.isFinished(Number(p.next_start), total),
        busy: await VideoEditJob.hasActiveClipJob(req.user.id, key),
      },
    });
  } catch (err) {
    next(err);
  }
}

// Start over for this video: the next clips begin at 0:00 again.
// (Clips that already exist in the history / Drive are not deleted.)
async function resetClipProgress(req, res, next) {
  try {
    const url = String(req.query.url || '').trim();
    if (!url || !videoDownloadService.isValidUrl(url)) {
      return res.status(400).json({ success: false, message: 'A valid video URL is required' });
    }
    const key = clipSplitter.normalizeSourceKey(url);
    if (await VideoEditJob.hasActiveClipJob(req.user.id, key)) {
      return res.status(409).json({ success: false, message: 'Clips for this video are being made right now. Try again when they finish.' });
    }
    await VideoClipProgress.reset(req.user.id, key);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

// ---- Instant preview: disk cache + HTTP Range support -------------------
// Streaming straight from Google Drive on every play was slow and could not
// seek (Range requests were ignored). Now the finished video is cached on
// local disk (first request, or pre-warmed by the page) and served with full
// Range support, so playback starts immediately and scrubbing works.
const fsp = require('fs');
const pathMod = require('path');
const env = require('./config.env');
const CACHE_DIR = pathMod.join(env.upload.tempDir, 'preview-cache');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const inflight = new Map();

function cachePathFor(jobId) {
  return pathMod.join(CACHE_DIR, `${jobId}.mp4`);
}

function evictOldCache() {
  try {
    const now = Date.now();
    for (const f of fsp.readdirSync(CACHE_DIR)) {
      const p = pathMod.join(CACHE_DIR, f);
      if (now - fsp.statSync(p).mtimeMs > CACHE_TTL_MS) fsp.unlinkSync(p);
    }
  } catch (_) { /* ignore */ }
}

function ensureCached(userId, job) {
  const dest = cachePathFor(job.id);
  if (fsp.existsSync(dest)) return Promise.resolve(dest);
  if (inflight.has(job.id)) return inflight.get(job.id);
  const p = (async () => {
    fsp.mkdirSync(CACHE_DIR, { recursive: true });
    evictOldCache();
    const tmp = await driveService.downloadFile(userId, job.drive_file_id, `preview_${job.id}.mp4`);
    fsp.renameSync(tmp, dest); // same filesystem (both under tempDir)
    return dest;
  })().finally(() => inflight.delete(job.id));
  inflight.set(job.id, p);
  return p;
}

function serveFile(req, res, filePath, { download, fileName }) {
  const { size } = fsp.statSync(filePath);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${fileName}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  const range = req.headers.range;
  if (!range) {
    res.setHeader('Content-Length', size);
    return fsp.createReadStream(filePath).pipe(res);
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  let start = m && m[1] ? parseInt(m[1], 10) : 0;
  let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
  if (m && !m[1] && m[2]) { start = Math.max(size - parseInt(m[2], 10), 0); end = size - 1; }
  if (isNaN(start) || start >= size || end < start) {
    res.status(416).setHeader('Content-Range', `bytes */${size}`);
    return res.end();
  }
  end = Math.min(end, size - 1);
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', end - start + 1);
  return fsp.createReadStream(filePath, { start, end }).pipe(res);
}

async function streamFile(req, res, next) {
  try {
    const job = await VideoEditJob.findById(req.user.id, req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
    if (job.status !== 'completed') {
      return res.status(409).json({ success: false, message: 'This video is not ready yet' });
    }
    const download = req.query.download === '1';
    const fileName = job.drive_file_name || 'video.mp4';
    const opts = { download, fileName };

    if (job.local_file_path) {
      if (!fsp.existsSync(job.local_file_path)) {
        return res.status(410).json({ success: false, message: 'This video is no longer available locally (it was not saved to Drive and has since expired).' });
      }
      return serveFile(req, res, job.local_file_path, opts);
    }
    if (!job.drive_file_id) {
      return res.status(409).json({ success: false, message: 'This video has no file to preview' });
    }
    // warm-up ping from the page: start caching in the background, reply fast
    if (req.query.warm === '1') {
      ensureCached(req.user.id, job).catch((e) => logger.warn(`[video-edit] preview warm failed: ${e.message}`));
      return res.status(202).json({ success: true });
    }
    const cached = await ensureCached(req.user.id, job);
    return serveFile(req, res, cached, opts);
  } catch (err) {
    next(err);
  }
}

async function deleteJob(req, res, next) {
  try {
    const job = await VideoEditJob.findById(req.user.id, req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
    if (job.local_file_path) require('fs').unlink(job.local_file_path, () => {});
    fsp.unlink(cachePathFor(job.id), () => {});
    await VideoEditJob.deleteById(req.user.id, req.params.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

async function clearHistory(req, res, next) {
  try {
    const jobs = await VideoEditJob.listByUser(req.user.id, 1000);
    jobs.forEach((j) => { if (j.local_file_path) require('fs').unlink(j.local_file_path, () => {}); fsp.unlink(cachePathFor(j.id), () => {}); });
    await VideoEditJob.deleteAllForUser(req.user.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, listJobs, streamFile, deleteJob, clearHistory, clipProgress, resetClipProgress };
