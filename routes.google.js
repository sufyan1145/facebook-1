const express = require('express');
const router = express.Router();
const googleController = require('./controllers.googleController');
const { requireAuth } = require('./middleware.auth');

router.get('/connect', requireAuth, googleController.getAuthUrl);
router.get('/callback', googleController.handleCallback); // state carries user id
router.post('/disconnect', requireAuth, googleController.disconnect);

module.exports = router;
