const { Queue, QueueEvents } = require('bullmq');
const connection = require('./queue.connection');

const uploadQueue = new Queue('video-upload', { connection });
const uploadQueueEvents = new QueueEvents('video-upload', { connection });

// Separate queue for Text + Image Posts - its own BullMQ queue name, so it has
// independent concurrency/backoff and cannot back up or interfere with the
// video-upload queue above.
const textImagePostQueue = new Queue('text-image-post', { connection });

async function addTextImagePostJob(data, opts = {}) {
  return textImagePostQueue.add('post-text-image', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 200,
    removeOnFail: 200,
    ...opts,
  });
}

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

module.exports = { uploadQueue, uploadQueueEvents, addUploadJob, pauseQueue, resumeQueue, cancelJob, getQueueStatus, textImagePostQueue, addTextImagePostJob };
