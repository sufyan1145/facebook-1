const express = require('express');
const router = express.Router();
const videoGenController = require('./controllers.videoGenController');
const { requireAuth } = require('./middleware.auth');

router.post('/generate', requireAuth, videoGenController.generate);
router.get('/jobs', requireAuth, videoGenController.listJobs);

module.exports = router;
