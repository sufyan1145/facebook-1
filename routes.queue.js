const express = require('express');
const router = express.Router();
const queueController = require('./controllers.queueController');
const { requireAuth } = require('./middleware.auth');

router.get('/status', requireAuth, queueController.status);
router.post('/pause', requireAuth, queueController.pause);
router.post('/resume', requireAuth, queueController.resume);
router.delete('/:jobId', requireAuth, queueController.cancel);

module.exports = router;
