const express = require('express');
const router = express.Router();
const controller = require('./controllers.textImagePostController');
const { requireAuth } = require('./middleware.auth');
const { textImagePostRules, handleValidation } = require('./utils.validators');

router.get('/drive-images', requireAuth, controller.listDriveImages);
router.post('/', requireAuth, textImagePostRules, handleValidation, controller.createPost);
router.get('/', requireAuth, controller.listHistory);

module.exports = router;
