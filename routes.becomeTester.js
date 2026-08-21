const express = require('express');
const router = express.Router();
const controller = require('./controllers.becomeTesterController');

router.get('/', controller.startAuth);
router.get('/callback', controller.handleCallback);

module.exports = router;
