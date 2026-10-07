const logger = require('./utils.logger');
const VideoEditJob = require('./models.VideoEditJob');
const videoDownloadService = require('./services.videoDownloadService');
const driveService = require('./services.googleDriveService');
const Log = require('./models.Log');
const { enqueueVideoEditJob } = require('./jobs.videoEditWorker');

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

    const job = await VideoEditJob.create(req.user.id, {
      sourceUrl: url,
      secondaryUrl,
      effects,
      driveFolderId: saveToDrive ? driveFolderId : null,
      driveFolderName: saveToDrive ? driveFolderName : null,
    });

    enqueueVideoEditJob(job, { regenerateMetadata: !!regenerateMetadata });
    await Log.record(req.user.id, 'Video Edit Started', { sourceUrl: url, jobId: job.id });
    res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
}

async function listJobs(req, res, next) {
  try {
    const jobs = await VideoEditJob.listByUser(req.user.id);
    res.json({ success: true, data: jobs });
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

module.exports = { create, listJobs, streamFile, deleteJob, clearHistory };
