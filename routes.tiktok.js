const express = require('express');
const router = express.Router();
const tiktokController = require('./controllers.tiktokController');
const { requireAuth } = require('./middleware.auth');

router.post('/download', requireAuth, tiktokController.download);
router.get('/jobs', requireAuth, tiktokController.listJobs);
router.get('/jobs/:id/file', requireAuth, tiktokController.streamFile);

module.exports = router;
