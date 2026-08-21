const driveService = require('./services.googleDriveService');
const TextImagePost = require('./models.TextImagePost');
const Page = require('./models.Page');
const Log = require('./models.Log');
const { addTextImagePostJob } = require('./queue.queues');

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
