const fs = require('fs');
const path = require('path');
const driveService = require('./services.googleDriveService');
const facebookService = require('./services.facebookService');
const TextImagePost = require('./models.TextImagePost');
const Page = require('./models.Page');
const Log = require('./models.Log');
const { addTextImagePostJob } = require('./queue.queues');
const imageGenService = require('./services.imageGenService');
const previewStore = require('./services.previewStore');
const credits = require('./utils.credits');
const env = require('./config.env');

// Fetches the actual posted image for a history row (used by the History
// table's "Preview" button) - straight from Facebook, since our own temp
// file was deleted right after the original post completed.
async function getHistoryImage(req, res, next) {
  try {
    const post = await TextImagePost.findByIdForUser(req.user.id, req.params.id);
    if (!post || post.status !== 'success' || !post.facebook_post_id) {
      return res.status(404).json({ success: false, message: 'No posted image available for this entry' });
    }
    const page = await Page.findById(req.user.id, post.page_id);
    if (!page) return res.status(404).json({ success: false, message: 'Page no longer available' });

    const imageUrl = await facebookService.getPostImageUrl(post.facebook_post_id, page.page_access_token);
    if (!imageUrl) return res.status(404).json({ success: false, message: 'Facebook did not return an image for this post' });

    res.json({ success: true, data: { imageUrl } });
  } catch (err) {
    next(err);
  }
}

// Lists images in a chosen Drive folder, for the "pick from my Drive" option.
// If pageId is given, images already successfully posted to that page are
// excluded so the same image never gets suggested twice for the same page.
async function listDriveImages(req, res, next) {
  try {
    const { folderId, pageId } = req.query;
    if (!folderId) return res.status(400).json({ success: false, message: 'folderId is required' });
    const images = await driveService.listImagesInFolder(req.user.id, folderId);

    if (pageId) {
      const postedIds = await TextImagePost.getPostedFileIds(pageId);
      const postedSet = new Set(postedIds);
      const fresh = images.filter((img) => !postedSet.has(img.id));
      return res.json({ success: true, data: fresh });
    }

    res.json({ success: true, data: images });
  } catch (err) {
    next(err);
  }
}

// Generates an AI image right now (for the "live preview" step) without
// posting anything to Facebook. Charges the AI-image credit here, since this
// is the point where the image is actually generated - if the person never
// posts the preview, the generation still happened and is still charged,
// same as generating it at post-time would have been.
async function previewAiImage(req, res, next) {
  try {
    const prompt = (req.body.aiPrompt || '').trim();
    if (!prompt) return res.status(400).json({ success: false, message: 'aiPrompt is required' });

    await credits.charge(req.user.id, 1, 'text_image_post_ai', 'preview');

    if (!fs.existsSync(env.upload.tempDir)) fs.mkdirSync(env.upload.tempDir, { recursive: true });
    const tempPath = path.join(env.upload.tempDir, `preview_${req.user.id}_${Date.now()}.png`);
    await imageGenService.generateImage(prompt, tempPath);

    const buffer = fs.readFileSync(tempPath);
    fs.unlinkSync(tempPath); // the bytes now live in Redis (previewStore) - no need to keep the local file
    const previewId = await previewStore.savePreview(req.user.id, buffer);

    res.json({ success: true, data: { previewId } });
  } catch (err) {
    if (err.code === 'INSUFFICIENT_CREDITS') {
      return res.status(402).json({ success: false, message: err.message });
    }
    next(err);
  }
}

// Streams a previously generated preview image back for display in an <img> tag.
async function getPreviewImage(req, res, next) {
  try {
    const preview = await previewStore.getPreview(req.params.previewId);
    if (!preview || preview.userId !== req.user.id) {
      return res.status(404).json({ success: false, message: 'Preview not found or expired' });
    }
    res.set('Content-Type', 'image/png');
    res.send(preview.buffer);
  } catch (err) {
    next(err);
  }
}

async function createPost(req, res, next) {
  try {
    const page = await Page.findById(req.user.id, req.body.pageId);
    if (!page || !page.is_connected) {
      return res.status(400).json({ success: false, message: 'Selected Facebook Page is not connected' });
    }

    // Safety net even if the request bypasses the picker's own filtering above -
    // never let the exact same Drive image go to the same Page twice.
    if (req.body.imageSource === 'drive') {
      const alreadyPosted = await TextImagePost.wasAlreadyPostedToPage(req.body.pageId, req.body.driveFileId);
      if (alreadyPosted) {
        return res.status(409).json({ success: false, message: 'This image has already been posted to this Page. Pick a different image.' });
      }
    }

    // If the person previewed an AI image first, confirm that preview still
    // exists and belongs to them before queueing - the worker will consume it
    // by previewId instead of generating (and charging for) a new image.
    if (req.body.imageSource === 'ai' && req.body.previewId) {
      const preview = await previewStore.getPreview(req.body.previewId);
      if (!preview || preview.userId !== req.user.id) {
        return res.status(400).json({ success: false, message: 'That preview has expired - generate a new preview before posting.' });
      }
    }

    const post = await TextImagePost.create(req.user.id, req.body);
    await addTextImagePostJob({
      userId: req.user.id,
      postId: post.id,
      pageId: req.body.pageId,
      pageDbId: req.body.pageId,
      message: req.body.message,
      imageSource: req.body.imageSource,
      driveFileId: req.body.driveFileId,
      driveFileName: req.body.driveFileName,
      aiPrompt: req.body.aiPrompt,
      previewId: req.body.previewId || null,
    });
    await Log.record(req.user.id, 'Text+Image Post Queued', { postId: post.id, source: req.body.imageSource });

    res.status(201).json({ success: true, data: post });
  } catch (err) {
    next(err);
  }
}

async function listHistory(req, res, next) {
  try {
    const posts = await TextImagePost.listByUser(req.user.id);
    res.json({ success: true, data: posts });
  } catch (err) {
    next(err);
  }
}

module.exports = { listDriveImages, previewAiImage, getPreviewImage, createPost, listHistory, getHistoryImage };
