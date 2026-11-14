const express = require('express');
const { requireAuth } = require('./middleware.auth');
const c = require('./controllers.pinterestController');

const router = express.Router();
router.get('/connect', requireAuth, c.connect);
router.get('/callback', c.callback); // Pinterest redirects the browser here; the signed state identifies the user
router.get('/accounts', requireAuth, c.listAccounts);
router.get('/accounts/:id/boards', requireAuth, c.boards);
router.post('/accounts/:id/board', requireAuth, c.setBoard);
router.delete('/accounts/:id', requireAuth, c.remove);

module.exports = router;
