/**
 * Runs one TikTok-download job end to end: fetch original caption -> download
 * the video -> ask Gemini for a fresh title/hashtags -> save to Drive (or
 * keep locally if no folder was chosen) -> mark completed/failed.
 * Fully self-contained - does not touch any other feature's tables or code.
 */
const path = require('path');
const fs = require('fs');
const env = require('./config.env');
const logger = require('./utils.logger');
const TikTokJob = require('./models.TikTokJob');
const tiktokService = require('./services.tiktokService');
const geminiService = require('./services.geminiService');
const driveService = require('./services.googleDriveService');
const Log = require('./models.Log');
const { notifyUploadEvent } = require('./services.notificationService');

async function processTikTokJob(job, { regenerateMetadata = true } = {}) {
  const tempFiles = [];
  try {
    await TikTokJob.setStatus(job.id, 'fetching_info');
    const meta = await tiktokService.getMetadata(job.source_url);
    await TikTokJob.setOriginalMetadata(job.id, { originalTitle: meta.title, originalDescription: meta.description });

    await TikTokJob.setStatus(job.id, 'downloading');
    const rawPath = path.join(env.upload.tempDir, `${job.id}_tiktok.mp4`);
    await tiktokService.downloadVideo(job.source_url, rawPath);
    tempFiles.push(rawPath);

    // Fall back to the ORIGINAL title/caption whenever AI regeneration is
    // turned off, or if it's on but Gemini fails (e.g. quota/credits ran
    // out) - the download still completes either way instead of failing.
    let finalTitle = meta.title || 'TikTok video';
    let finalHashtags = '';
    if (regenerateMetadata) {
      await TikTokJob.setStatus(job.id, 'regenerating_metadata');
      try {
        const regenerated = await geminiService.regenerateTitleAndHashtags(meta.title, meta.description);
        finalTitle = regenerated.title;
        finalHashtags = regenerated.hashtags;
      } catch (aiErr) {
        logger.error(`[tiktok] AI title/hashtag regeneration failed for job ${job.id}, falling back to original caption: ${aiErr.message}`);
        await Log.record(job.user_id, 'TikTok AI Regeneration Failed - Used Original Caption', { sourceUrl: job.source_url, error: aiErr.message }, 'error');
      }
    }

    const safeFileName = `${finalTitle.replace(/[^a-z0-9]+/gi, '_').slice(0, 60) || 'tiktok_video'}.mp4`;

    if (job.drive_folder_id) {
      const uploaded = await driveService.uploadFile(job.user_id, job.drive_folder_id, rawPath, safeFileName);
      await TikTokJob.markCompleted(job.id, {
        driveFileId: uploaded.id,
        driveFileName: uploaded.name,
        generatedTitle: finalTitle,
        generatedHashtags: finalHashtags,
      });
      await Log.record(job.user_id, 'TikTok Video Downloaded', { sourceUrl: job.source_url, driveFileName: uploaded.name });
      await notifyUploadEvent(job.user_id, { type: 'success', videoName: uploaded.name, pageName: 'TikTok Downloader' });
    } else {
      const localPath = path.join(env.upload.tempDir, `${job.id}_${safeFileName}`);
      fs.renameSync(rawPath, localPath);
      await TikTokJob.markCompleted(job.id, {
        localFilePath: localPath,
        driveFileName: safeFileName,
        generatedTitle: finalTitle,
        generatedHashtags: finalHashtags,
      });
      await Log.record(job.user_id, 'TikTok Video Downloaded', { sourceUrl: job.source_url, driveFileName: safeFileName, note: 'Not saved to Drive' });
      await notifyUploadEvent(job.user_id, { type: 'success', videoName: safeFileName, pageName: 'TikTok Downloader' });
    }
    logger.info(`[tiktok] completed job ${job.id}`);
  } catch (err) {
    logger.error(`[tiktok] failed job ${job.id}: ${err.message}`);
    await TikTokJob.markFailed(job.id, err.message);
    await Log.record(job.user_id, 'TikTok Download Failed', { sourceUrl: job.source_url, error: err.message }, 'error');
  } finally {
    tempFiles.forEach(driveService.deleteTempFile);
  }
}

module.exports = { processTikTokJob };
