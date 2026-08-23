const { Worker } = require('bullmq');
const fs = require('fs');
const path = require('path');
const connection = require('./queue.connection');
const logger = require('./utils.logger');
const env = require('./config.env');
const driveService = require('./services.googleDriveService');
const facebookService = require('./services.facebookService');
const imageGenService = require('./services.imageGenService');
const previewStore = require('./services.previewStore');
const ocrService = require('./services.ocrService');
const TextImagePost = require('./models.TextImagePost');
const Page = require('./models.Page');
const Log = require('./models.Log');
const credits = require('./utils.credits');

const worker = new Worker(
  'text-image-post',
  async (job) => {
    const { userId, postId, pageId, pageDbId, imageSource, driveFileId, driveFileName, aiPrompt, previewId } = job.data;
    let { message } = job.data;

    await TextImagePost.markProcessing(postId);

    let tempPath;
    try {
      if (imageSource === 'drive') {
        tempPath = await driveService.downloadFile(userId, driveFileId, driveFileName || 'image.jpg');
      } else if (previewId) {
        // Already generated (and already charged) during the live-preview step -
        // pull the exact bytes the person saw, don't regenerate or charge again.
        const preview = await previewStore.getPreview(previewId);
        if (!preview) throw new Error('Preview image expired before it could be posted');
        if (!fs.existsSync(env.upload.tempDir)) fs.mkdirSync(env.upload.tempDir, { recursive: true });
        tempPath = path.join(env.upload.tempDir, `${postId}_ai.png`);
        fs.writeFileSync(tempPath, preview.buffer);
        await previewStore.deletePreview(previewId);
      } else {
        // AI-generated, no preview used: charge credits upfront (throws InsufficientCreditsError if not enough).
        await credits.charge(userId, 1, 'text_image_post_ai', postId);
        if (!fs.existsSync(env.upload.tempDir)) fs.mkdirSync(env.upload.tempDir, { recursive: true });
        tempPath = path.join(env.upload.tempDir, `${postId}_ai.png`);
        await imageGenService.generateImage(aiPrompt, tempPath);
      }

      // No manual text and no AI-generated caption ended up set - fall back to
      // whatever text is actually written inside the image itself (OCR).
      // Never blocks posting: if OCR finds nothing or fails, the post just
      // goes out without a caption, same as if this step didn't exist.
      if (!message || !message.trim()) {
        const ocrText = await ocrService.extractTextFromImage(tempPath);
        if (ocrText) {
          message = ocrText;
          await Log.record(userId, 'Text+Image Post Caption From Image Text', { postId, extractedLength: ocrText.length });
        }
      }

      const page = await Page.findById(userId, pageDbId);
      if (!page) throw new Error('Facebook page not found or disconnected');

      const fbPostId = await facebookService.postPhotoToPage({
        pageId: page.page_id,
        pageAccessToken: page.page_access_token,
        filePath: tempPath,
        message,
      });

      await TextImagePost.markSuccess(postId, fbPostId, message);
      await Log.record(userId, 'Text+Image Post Published', { postId, page: page.page_name, source: imageSource });

      return { fbPostId };
    } catch (err) {
      await TextImagePost.markFailed(postId, err.message);
      await Log.record(userId, 'Text+Image Post Failed', { postId, error: err.message }, 'error');
      throw err;
    } finally {
      if (tempPath) driveService.deleteTempFile(tempPath);
    }
  },
  // Independent, modest concurrency - deliberately not shared with the video-upload
  // worker's concurrency setting, so this feature can never crowd out video posting.
  { connection, concurrency: Number(process.env.TEXT_IMAGE_POST_CONCURRENCY) || 10 }
);

worker.on('completed', (job) => logger.info(`Text+Image post job ${job.id} completed`));
worker.on('failed', (job, err) => logger.error(`Text+Image post job ${job?.id} failed: ${err.message}`));

module.exports = worker;
