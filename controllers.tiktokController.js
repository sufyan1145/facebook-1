const TikTokJob = require('./models.TikTokJob');
const tiktokService = require('./services.tiktokService');
const driveService = require('./services.googleDriveService');
const Log = require('./models.Log');
const { enqueueTikTokJob } = require('./jobs.tiktokDownloadWorker');

async function download(req, res, next) {
  try {
    const { url, driveFolderId, driveFolderName, saveToDrive, regenerateMetadata } = req.body;
    if (!url) return res.status(400).json({ success: false, message: 'A TikTok video URL is required' });
    if (!tiktokService.isTikTokUrl(url)) {
      return res.status(400).json({ success: false, message: 'This does not look like a TikTok video URL' });
    }
    if (saveToDrive && !driveFolderId) {
      return res.status(400).json({ success: false, message: 'Please select a Drive folder, or turn off "Save to Google Drive"' });
    }

    const job = await TikTokJob.create(req.user.id, {
      sourceUrl: url,
      driveFolderId: saveToDrive ? driveFolderId : null,
      driveFolderName: saveToDrive ? driveFolderName : null,
    });

    // Long-running (download + AI rewrite) - queued so multiple submissions
    // (the "multiple videos" mode) run one at a time instead of all at once;
    // responds immediately, the frontend polls /tiktok/jobs for progress.
    enqueueTikTokJob(job, { regenerateMetadata: regenerateMetadata !== false });

    await Log.record(req.user.id, 'TikTok Download Started', { sourceUrl: url, jobId: job.id });
    res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
}

async function listJobs(req, res, next) {
  try {
    const jobs = await TikTokJob.listByUser(req.user.id);
    res.json({ success: true, data: jobs });
  } catch (err) {
    next(err);
  }
}

async function streamFile(req, res, next) {
  try {
    const job = await TikTokJob.findById(req.user.id, req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
    if (job.status !== 'completed') {
      return res.status(409).json({ success: false, message: 'This video is not ready yet' });
    }

    const download = req.query.download === '1';
    const fileName = job.drive_file_name || 'video.mp4';

    if (job.local_file_path) {
      const fs = require('fs');
      if (!fs.existsSync(job.local_file_path)) {
        return res.status(410).json({ success: false, message: 'This video is no longer available locally (it was not saved to Drive and has since expired).' });
      }
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${fileName}"`);
      res.setHeader('Accept-Ranges', 'bytes');
      return fs.createReadStream(job.local_file_path).pipe(res);
    }

    if (!job.drive_file_id) {
      return res.status(409).json({ success: false, message: 'This video has no file to preview' });
    }
    await driveService.streamFile(req.user.id, job.drive_file_id, res, { download, fileName });
  } catch (err) {
    next(err);
  }
}

module.exports = { download, listJobs, streamFile };
