const express = require('express');
const { requireAuth } = require('./middleware.auth');
const c = require('./controllers.instagramController');

const router = express.Router();
router.get('/connect', requireAuth, c.connect);
router.get('/callback', c.callback); // Instagram redirects the browser here; the signed state identifies the user
router.get('/accounts', requireAuth, c.listAccounts);
router.delete('/accounts/:id', requireAuth, c.remove);

module.exports = router;
