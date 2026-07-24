const express = require('express');
const router = express.Router();
const youtubeController = require('./controllers.youtubeController');
const { requireAuth } = require('./middleware.auth');

router.get('/connect', requireAuth, youtubeController.getAuthUrl);
router.get('/callback', youtubeController.handleCallback); // state carries user id
router.get('/accounts', requireAuth, youtubeController.listAccounts);
router.post('/disconnect/:id', requireAuth, youtubeController.disconnect);

module.exports = router;
