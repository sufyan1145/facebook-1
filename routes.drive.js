const express = require('express');
const router = express.Router();
const driveController = require('./controllers.driveController');
const { requireAuth } = require('./middleware.auth');

router.get('/browse', requireAuth, driveController.browseFolders);
router.get('/search', requireAuth, driveController.searchFolders);
router.get('/folders', requireAuth, driveController.listSavedFolders);

module.exports = router;
