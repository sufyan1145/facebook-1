const express = require('express');
const router = express.Router();
const logsController = require('./controllers.logsController');
const { requireAuth } = require('./middleware.auth');

router.get('/', requireAuth, logsController.list);

module.exports = router;
