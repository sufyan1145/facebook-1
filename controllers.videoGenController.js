const VideoGenJob = require('./models.VideoGenJob');
const kieVideoService = require('./services.kieVideoService');
const driveService = require('./services.googleDriveService');
const Log = require('./models.Log');
const credits = require('./utils.credits');
const { generateWithVertex } = require('./jobs.videoGenWorker');

async function generate(req, res, next) {
  try {
    const { driveFolderId, driveFolderName, topic, duration, aspectRatio, provider } = req.body;
    if (!driveFolderId || !topic) {
      return res.status(400).json({ success: false, message: 'driveFolderId and topic are required' });
    }
    const useVertex = provider === 'vertex';
    const requestedDurationSeconds = Number(duration) || (useVertex ? 8 : 5);

    // Fail fast with a clear message before creating anything if the account
    // doesn't have enough credits for this length of video.
    if (useVertex) {
      const balance = await credits.getBalance(req.user.id);
      const cost = credits.costForSeconds(requestedDurationSeconds);
      if (balance.creditsRemaining < cost) {
        return res.status(402).json({
          success: false,
          message: `Not enough credits: this needs ${cost}, you have ${balance.creditsRemaining} remaining this month.`,
        });
      }
    }

    const job = await VideoGenJob.create(req.user.id, {
      driveFolderId,
      driveFolderName,
      topic,
      duration,
      aspectRatio,
      provider: useVertex ? 'vertex' : 'kie',
      requestedDurationSeconds: useVertex ? requestedDurationSeconds : null,
    });

    if (useVertex) {
      // Long-running (multi-minute) generation - run in the background and
      // respond immediately; the frontend polls /videogen/jobs for progress.
      generateWithVertex(job).catch((err) => {
        // generateWithVertex already handles its own failure bookkeeping;
        // this catch only guards against a truly unexpected crash.
        require('./utils.logger').error(`[video-gen-vertex] unhandled error for job ${job.id}: ${err.message}`);
      });
      await Log.record(req.user.id, 'Video Generation Started', { topic, jobId: job.id, provider: 'vertex' });
      return res.json({ success: true, data: job });
    }

    try {
      const taskId = await kieVideoService.createVideoTask({ prompt: topic, duration, aspectRatio });
      await VideoGenJob.setTaskId(job.id, taskId);
      await Log.record(req.user.id, 'Video Generation Started', { topic, jobId: job.id, provider: 'kie' });
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

// Streams the finished video for live preview (inline) or download
// (?download=1), proxied through our server so the Drive file doesn't need
// to be made public.
async function streamFile(req, res, next) {
  try {
    const job = await VideoGenJob.findById(req.user.id, req.params.id);
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
    if (job.status !== 'completed' || !job.drive_file_id) {
      return res.status(409).json({ success: false, message: 'This video is not ready yet' });
    }
    await driveService.streamFile(req.user.id, job.drive_file_id, res, {
      download: req.query.download === '1',
      fileName: job.drive_file_name || 'video.mp4',
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { generate, listJobs, streamFile };
