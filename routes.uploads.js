const express = require('express');
const router = express.Router();
const uploadController = require('./controllers.uploadController');
const { requireAuth } = require('./middleware.auth');

router.get('/history', requireAuth, uploadController.history);

module.exports = router;
