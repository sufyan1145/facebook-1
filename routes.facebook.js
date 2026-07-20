const express = require('express');
const router = express.Router();
const facebookController = require('./controllers.facebookController');
const { requireAuth } = require('./middleware.auth');

router.get('/connect', requireAuth, facebookController.getAuthUrl);
router.get('/callback', facebookController.handleCallback); // state carries user id
router.get('/accounts', requireAuth, facebookController.listAccounts);
router.post('/disconnect/:id', requireAuth, facebookController.disconnect);

module.exports = router;
