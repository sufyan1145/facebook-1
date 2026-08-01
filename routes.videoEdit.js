const express = require('express');
const router = express.Router();
const videoEditController = require('./controllers.videoEditController');
const { requireAuth } = require('./middleware.auth');

router.post('/create', requireAuth, videoEditController.create);
router.get('/jobs', requireAuth, videoEditController.listJobs);
router.get('/jobs/:id/file', requireAuth, videoEditController.streamFile);
router.delete('/jobs/:id', requireAuth, videoEditController.deleteJob);
router.delete('/jobs', requireAuth, videoEditController.clearHistory);

module.exports = router;
