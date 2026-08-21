const express = require('express');
const router = express.Router();
const controller = require('./controllers.textImagePostController');
const { requireAuth } = require('./middleware.auth');
const { textImagePostRules, handleValidation } = require('./utils.validators');

router.get('/drive-images', requireAuth, controller.listDriveImages);
router.post('/preview-ai', requireAuth, controller.previewAiImage);
router.get('/preview-ai/:previewId', requireAuth, controller.getPreviewImage);
router.post('/', requireAuth, textImagePostRules, handleValidation, controller.createPost);
router.get('/', requireAuth, controller.listHistory);
router.get('/:id/image', requireAuth, controller.getHistoryImage);

module.exports = router;
