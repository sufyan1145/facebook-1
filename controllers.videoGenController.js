const VideoGenJob = require('./models.VideoGenJob');
const kieVideoService = require('./services.kieVideoService');
const Log = require('./models.Log');

async function generate(req, res, next) {
  try {
    const { driveFolderId, driveFolderName, topic, duration, aspectRatio } = req.body;
    if (!driveFolderId || !topic) {
      return res.status(400).json({ success: false, message: 'driveFolderId and topic are required' });
    }

    const job = await VideoGenJob.create(req.user.id, { driveFolderId, driveFolderName, topic, duration, aspectRatio });

    try {
      const taskId = await kieVideoService.createVideoTask({ prompt: topic, duration, aspectRatio });
      await VideoGenJob.setTaskId(job.id, taskId);
      await Log.record(req.user.id, 'Video Generation Started', { topic, jobId: job.id });
    } catch (err) {
      const message = err.response?.data?.msg || err.message;
      await VideoGenJob.markFailed(job.id, message);
      await Log.record(req.user.id, 'Video Generation Failed', { topic, error: message }, 'error');
      return res.status(502).json({ success: false, message });
    }

    res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
}

async function listJobs(req, res, next) {
  try {
    const jobs = await VideoGenJob.listByUser(req.user.id);
    res.json({ success: true, data: jobs });
  } catch (err) {
    next(err);
  }
}

module.exports = { generate, listJobs };
