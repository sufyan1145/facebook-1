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

async function streamFile(req, res, next) {
  try {
    const job = await VideoEditJob.findById(req.user.id, req.params.id);
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

async function deleteJob(req, res, next) {
  try {
    const job = await VideoEditJob.findById(req.user.id, req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
    if (job.local_file_path) require('fs').unlink(job.local_file_path, () => {});
    await VideoEditJob.deleteById(req.user.id, req.params.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

async function clearHistory(req, res, next) {
  try {
    const jobs = await VideoEditJob.listByUser(req.user.id, 1000);
    jobs.forEach((j) => { if (j.local_file_path) require('fs').unlink(j.local_file_path, () => {}); });
    await VideoEditJob.deleteAllForUser(req.user.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, listJobs, streamFile, deleteJob, clearHistory };
