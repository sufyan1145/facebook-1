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
const TikTokJob = require('./models.TikTokJob');
const ffmpeg = require('./utils.ffmpeg');
const path = require('path');

const worker = new Worker(
  'video-upload',
  async (job) => {
    const {
      userId, scheduleId, pageDbId, folderGoogleId, file, caption: scheduleCaption, hashtags: scheduleHashtags, privacy,
      publishImmediately, pageName, postToFacebook, youtubeTokenId, youtubeVideoType,
      autoBackgroundMusic, musicFolderId,
    } = job.data;

    // If this exact file was downloaded via the TikTok Downloader, use its
    // AI-regenerated title/hashtags as the caption instead of the schedule's
    // generic one - applies to both the Facebook post and the YouTube title.
    let caption = scheduleCaption;
    let hashtags = scheduleHashtags;
    let tiktokJob = null;
    try {
      tiktokJob = await TikTokJob.findByDriveFileId(file.id);
      if (tiktokJob && tiktokJob.generated_title) {
        caption = tiktokJob.generated_title;
        hashtags = tiktokJob.generated_hashtags || scheduleHashtags;
        logger.info(`Using TikTok-regenerated caption for ${file.name}`);
      }
    } catch (lookupErr) {
      logger.error(`TikTok caption lookup failed for ${file.name}: ${lookupErr.message}`);
    }

    await QueueJob.upsertFromBullJob(job, 'active', userId, scheduleId);

    let historyRow;
    try {
      historyRow = await UploadHistory.create(userId, {
        scheduleId,
        driveFileId: file.id,
        videoName: file.name,
        facebookPageId: pageDbId,
        driveFolderName: file.folderName,
        status: 'uploading',
      });
    } catch (createErr) {
      // This line used to be outside any try/catch - if it ever failed, the whole
      // job threw with no Upload History row AND no distinct log entry explaining
      // why, making it look like the upload vanished. Now it's traceable.
      logger.error(`Failed to create Upload History row for ${file.name}: ${createErr.message}`);
      await Log.record(userId, 'Upload Failed', { file: file.name, page: pageName, error: `History record could not be created: ${createErr.message}` }, 'error');
      throw createErr;
    }

    let tempPath;
    let downloadedPath;
    let musicTempPath;
    let processedTempPath;
    try {
      tempPath = downloadedPath = await driveService.downloadFile(userId, file.id, file.name);

      // Optional: mute the original audio and swap in a background track
      // picked at random from the user's chosen Drive folder. Failure here
      // (no tracks in the folder, download hiccup, ffmpeg error, etc.) should
      // never block the actual post - falls back to the original file with
      // its own audio untouched, same as if the option were off.
      if (autoBackgroundMusic && musicFolderId) {
        try {
          const tracks = await driveService.listAudioInFolder(userId, musicFolderId);
          if (tracks.length > 0) {
            const track = tracks[Math.floor(Math.random() * tracks.length)];
            musicTempPath = await driveService.downloadFile(userId, track.id, track.name);
            processedTempPath = path.join(path.dirname(tempPath), `music_${path.basename(tempPath)}`);
            await ffmpeg.muteAndAddMusic(tempPath, musicTempPath, processedTempPath);
            tempPath = processedTempPath;
            logger.info(`Applied background music "${track.name}" to ${file.name}`);
          } else {
            logger.info(`Auto background music enabled for ${file.name} but the chosen Drive folder has no audio files - posting original audio instead`);
          }
        } catch (musicErr) {
          logger.error(`Background music step failed for ${file.name}, posting original audio instead: ${musicErr.message}`);
          await Log.record(userId, 'Background Music Failed', { file: file.name, error: musicErr.message }, 'error');
        }
      }

      let fbVideoId = historyRow.facebook_video_id || null;
      if (postToFacebook !== false && pageDbId && !fbVideoId) {
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
      } else if (fbVideoId) {
        logger.info(`Skipping Facebook upload for ${file.name} - already uploaded in a previous attempt (${fbVideoId})`);
      }

      // YouTube is optional and best-effort: a failure here should not undo an
      // already-successful (or intentionally skipped) Facebook post.
      // Also skipped entirely if a previous (retried) attempt already uploaded
      // it - otherwise a retry caused by a later failure would upload twice.
      if (youtubeTokenId && !historyRow.youtube_video_id) {
        try {
          const tags = (hashtags || '').split(/\s+/).map((h) => h.replace(/^#/, '').trim()).filter(Boolean);
          const youtubeVideoId = await youtubeService.uploadVideo(userId, youtubeTokenId, tempPath, {
            title: (tiktokJob && tiktokJob.generated_title) || file.name.replace(/\.[^.]+$/, ''),
            description: caption || file.name,
            tags,
            videoType: youtubeVideoType,
          });
          await UploadHistory.markYoutubeUploaded(historyRow.id, youtubeVideoId);
          await Log.record(userId, 'YouTube Upload Completed', { file: file.name, youtubeVideoId });
        } catch (ytErr) {
          await Log.record(userId, 'YouTube Upload Failed', { file: file.name, error: ytErr.message }, 'error');
          logger.error(`YouTube upload failed for schedule ${scheduleId}: ${ytErr.message}`);
        }
      } else if (youtubeTokenId) {
        logger.info(`Skipping YouTube upload for ${file.name} - already uploaded in a previous attempt (${historyRow.youtube_video_id})`);
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
      if (downloadedPath && downloadedPath !== tempPath) driveService.deleteTempFile(downloadedPath);
      if (musicTempPath) driveService.deleteTempFile(musicTempPath);
    }
  },
  // Configurable so it can be tuned without a code change - e.g. lowered if
  // Facebook/YouTube start rate-limiting rapid concurrent posts (a platform-
  // side limit, separate from this server's own CPU/RAM capacity).
  { connection, concurrency: Number(process.env.UPLOAD_CONCURRENCY) || 50 }
);

worker.on('completed', (job) => logger.info(`Job ${job.id} completed`));
worker.on('failed', (job, err) => logger.error(`Job ${job?.id} failed: ${err.message}`));

module.exports = worker;
