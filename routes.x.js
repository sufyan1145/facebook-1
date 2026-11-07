const express = require('express');
const { requireAuth } = require('./middleware.auth');
const c = require('./controllers.xController');

const router = express.Router();
router.get('/accounts', requireAuth, c.listAccounts);
router.post('/accounts', requireAuth, c.addAccount);
router.post('/accounts/:id/check', requireAuth, c.checkAccount);
router.post('/accounts/:id/test', requireAuth, c.testPost);
router.delete('/accounts/:id', requireAuth, c.removeAccount);

module.exports = router;
