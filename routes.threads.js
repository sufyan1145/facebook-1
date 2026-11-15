const express = require('express');
const { requireAuth } = require('./middleware.auth');
const c = require('./controllers.threadsController');

const router = express.Router();
router.get('/connect', requireAuth, c.connect);
router.get('/callback', c.callback); // Threads redirects the browser here; the signed state identifies the user
router.get('/accounts', requireAuth, c.listAccounts);
router.delete('/accounts/:id', requireAuth, c.remove);

module.exports = router;
