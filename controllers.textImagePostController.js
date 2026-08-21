const driveService = require('./services.googleDriveService');
const TextImagePost = require('./models.TextImagePost');
const Page = require('./models.Page');
const Log = require('./models.Log');
const { addTextImagePostJob } = require('./queue.queues');

// Lists images in a chosen Drive folder, for the "pick from my Drive" option.
async function listDriveImages(req, res, next) {
  try {
    const { folderId } = req.query;
    if (!folderId) return res.status(400).json({ success: false, message: 'folderId is required' });
    const images = await driveService.listImagesInFolder(req.user.id, folderId);
    res.json({ success: true, data: images });
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

module.exports = { listDriveImages, createPost, listHistory };
