const { Worker } = require('bullmq');
const connection = require('./queue.connection');
const logger = require('./utils.logger');
const driveService = require('./services.googleDriveService');
const facebookService = require('./services.facebookService');
const youtubeService = require('./services.youtubeService');
const UploadHistory = require('./models.UploadHistory');
const Log = require('./models.Log');
const QueueJob = require('./models.QueueJob');
const { notifyUploadEvent } = require('./services.notificationService');
const Page = require('./models.Page');

const worker = new Worker(
  'video-upload',
  async (job) => {
    const {
      userId, scheduleId, pageDbId, folderGoogleId, file, caption, hashtags, privacy,
      publishImmediately, pageName, postToFacebook, youtubeTokenId, youtubeVideoType,
    } = job.data;

    await QueueJob.upsertFromBullJob(job, 'active', userId, scheduleId);

    const historyRow = await UploadHistory.create(userId, {
      scheduleId,
      driveFileId: file.id,
      videoName: file.name,
      facebookPageId: pageDbId,
      driveFolderName: file.folderName,
      status: 'uploading',
    });

    let tempPath;
    try {
      tempPath = await driveService.downloadFile(userId, file.id, file.name);

      let fbVideoId = null;
      if (postToFacebook !== false && pageDbId) {
        const page = await Page.findById(userId, pageDbId);
        if (!page) throw new Error('Facebook page not found or disconnected');

        fbVideoId = await facebookService.uploadVideoToPage({
          pageId: page.page_id,
          pageAccessToken: page.page_access_token,
          filePath: tempPath,
          caption,
          hashtags,
          privacy,
          publishImmediately,
        });
        await Log.record(userId, 'Video Uploaded', { file: file.name, page: pageName });
        await notifyUploadEvent(userId, { type: 'success', videoName: file.name, pageName });
      }

      // YouTube is optional and best-effort: a failure here should not undo an
      // already-successful (or intentionally skipped) Facebook post.
      if (youtubeTokenId) {
        try {
          const tags = (hashtags || '').split(/\s+/).map((h) => h.replace(/^#/, '').trim()).filter(Boolean);
          const youtubeVideoId = await youtubeService.uploadVideo(userId, youtubeTokenId, tempPath, {
            title: file.name.replace(/\.[^.]+$/, ''),
            description: caption || file.name,
            tags,
            videoType: youtubeVideoType,
          });
          await Log.record(userId, 'YouTube Upload Completed', { file: file.name, youtubeVideoId });
        } catch (ytErr) {
          await Log.record(userId, 'YouTube Upload Failed', { file: file.name, error: ytErr.message }, 'error');
          logger.error(`YouTube upload failed for schedule ${scheduleId}: ${ytErr.message}`);
        }
      }

      if (historyRow) await UploadHistory.markSuccess(historyRow.id, fbVideoId);
      await QueueJob.upsertFromBullJob(job, 'completed', userId, scheduleId);

      return { fbVideoId };
    } catch (err) {
      if (historyRow) await UploadHistory.markFailed(historyRow.id);
      const isFinalAttempt = job.attemptsMade + 1 >= job.opts.attempts;
      await QueueJob.upsertFromBullJob(job, isFinalAttempt ? 'failed' : 'active', userId, scheduleId, err.message);
      await Log.record(userId, 'Upload Failed', { file: file.name, page: pageName, error: err.message }, 'error');
      await notifyUploadEvent(userId, { type: 'failure', videoName: file.name, pageName });
      throw err; // let BullMQ retry with exponential backoff
    } finally {
      if (tempPath) driveService.deleteTempFile(tempPath);
    }
  },
  { connection, concurrency: 3 }
);

worker.on('completed', (job) => logger.info(`Job ${job.id} completed`));
worker.on('failed', (job, err) => logger.error(`Job ${job?.id} failed: ${err.message}`));

module.exports = worker;
