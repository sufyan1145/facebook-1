const express = require('express');
const router = express.Router();
const chatController = require('./controllers.chatController');
const { requireAuth } = require('./middleware.auth');

router.post('/', requireAuth, chatController.send);

module.exports = router;
