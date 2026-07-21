/**
 * Worker 6: AI Video Generation Poller
 * Periodically checks in-progress Kie.ai video generation jobs; once a job is
 * done, downloads the result and saves it into the target Google Drive folder
 * so the existing schedule/upload pipeline can pick it up like any other video.
 */
const cron = require('node-cron');
const path = require('path');
const env = require('./config.env');
const logger = require('./utils.logger');
const VideoGenJob = require('./models.VideoGenJob');
const kieVideoService = require('./services.kieVideoService');
const driveService = require('./services.googleDriveService');
const Log = require('./models.Log');
const { notifyUploadEvent } = require('./services.notificationService');

async function checkJob(job) {
  const status = await kieVideoService.getTaskStatus(job.kie_task_id);
  const state = status.state || status.status;

  if (state === 'success') {
    const resultUrl = kieVideoService.extractResultUrl(status);
    if (!resultUrl) {
      await VideoGenJob.markFailed(job.id, 'Video generated but no result URL was returned');
      return;
    }

    await VideoGenJob.setStatus(job.id, 'downloading');
    const fileName = `${job.id}.mp4`;
    const tempPath = path.join(env.upload.tempDir, fileName);
    let downloadedPath;
    try {
      downloadedPath = await kieVideoService.downloadResult(resultUrl, tempPath);
      const uploaded = await driveService.uploadFile(job.user_id, job.drive_folder_id, downloadedPath, fileName);
      await VideoGenJob.markCompleted(job.id, { driveFileId: uploaded.id, driveFileName: uploaded.name });
      await Log.record(job.user_id, 'Video Generated', { topic: job.topic, driveFileName: uploaded.name });
      await notifyUploadEvent(job.user_id, { type: 'success', videoName: uploaded.name, pageName: 'Video Generation' });
    } finally {
      driveService.deleteTempFile(downloadedPath);
    }
  } else if (state === 'fail') {
    const message = status.failMsg || status.failReason || 'Video generation failed';
    await VideoGenJob.markFailed(job.id, message);
    await Log.record(job.user_id, 'Video Generation Failed', { topic: job.topic, error: message }, 'error');
  }
  // waiting / queuing / generating -> leave as-is, will check again next tick
}

function startVideoGenWorker() {
  cron.schedule(env.kie.pollCron, async () => {
    try {
      const jobs = await VideoGenJob.listInProgress();
      for (const job of jobs) {
        try {
          await checkJob(job);
        } catch (err) {
          logger.error(`[video-gen] check failed for job ${job.id}: ${err.message}`);
          const ageMs = Date.now() - new Date(job.created_at).getTime();
          if (ageMs > 10 * 60 * 1000) {
            // Stuck for over 10 minutes with a real error each time -> stop retrying and surface it
            await VideoGenJob.markFailed(job.id, err.message);
          }
        }
      }
    } catch (err) {
      logger.error(`Video gen worker error: ${err.message}`);
    }
  });
  logger.info(`Video generation poller started with cron: ${env.kie.pollCron}`);
}

module.exports = { startVideoGenWorker };
