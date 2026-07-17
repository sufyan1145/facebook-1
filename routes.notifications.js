const express = require('express');
const router = express.Router();
const notificationController = require('./controllers.notificationController');
const { requireAuth } = require('./middleware.auth');

router.get('/', requireAuth, notificationController.list);
router.patch('/:id/read', requireAuth, notificationController.markRead);

module.exports = router;
