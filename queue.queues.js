const { Queue, QueueEvents } = require('bullmq');
const connection = require('./queue.connection');

const uploadQueue = new Queue('video-upload', { connection });
const uploadQueueEvents = new QueueEvents('video-upload', { connection });

async function addUploadJob(data, opts = {}) {
  return uploadQueue.add('upload-video', data, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 500,
    removeOnFail: 500,
    ...opts,
  });
}

async function pauseQueue() {
  await uploadQueue.pause();
}

async function resumeQueue() {
  await uploadQueue.resume();
}

async function cancelJob(jobId) {
  const job = await uploadQueue.getJob(jobId);
  if (job) await job.remove();
}

async function getQueueStatus() {
  const counts = await uploadQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
  return counts;
}

module.exports = { uploadQueue, uploadQueueEvents, addUploadJob, pauseQueue, resumeQueue, cancelJob, getQueueStatus };
