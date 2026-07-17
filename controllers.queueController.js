const { pauseQueue, resumeQueue, cancelJob, getQueueStatus } = require('./queue.queues');
const QueueJob = require('./models.QueueJob');
const Log = require('./models.Log');

async function status(req, res, next) {
  try {
    const counts = await getQueueStatus();
    const userJobs = await QueueJob.listByUser(req.user.id);
    res.json({ success: true, data: { counts, jobs: userJobs } });
  } catch (err) {
    next(err);
  }
}

async function pause(req, res, next) {
  try {
    await pauseQueue();
    await Log.record(req.user.id, 'Queue Paused', {});
    res.json({ success: true, message: 'Queue paused' });
  } catch (err) {
    next(err);
  }
}

async function resume(req, res, next) {
  try {
    await resumeQueue();
    await Log.record(req.user.id, 'Queue Resumed', {});
    res.json({ success: true, message: 'Queue resumed' });
  } catch (err) {
    next(err);
  }
}

async function cancel(req, res, next) {
  try {
    await cancelJob(req.params.jobId);
    await Log.record(req.user.id, 'Upload Cancelled', { jobId: req.params.jobId });
    res.json({ success: true, message: 'Job cancelled' });
  } catch (err) {
    next(err);
  }
}

module.exports = { status, pause, resume, cancel };
