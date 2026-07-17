const express = require('express');
const router = express.Router();
const settingsController = require('./controllers.settingsController');
const { requireAuth } = require('./middleware.auth');

router.get('/', requireAuth, settingsController.getSettings);
router.put('/', requireAuth, settingsController.updateSettings);

module.exports = router;
