const express = require('express');
const router = express.Router();
const pagesController = require('./controllers.pagesController');
const { requireAuth } = require('./middleware.auth');

router.post('/sync', requireAuth, pagesController.syncPages);
router.get('/', requireAuth, pagesController.listPages);
router.post('/:id/disconnect', requireAuth, pagesController.disconnectPage);

module.exports = router;
