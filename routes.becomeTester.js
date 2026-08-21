const express = require('express');
const router = express.Router();
const controller = require('./controllers.becomeTesterController');

router.post('/add', controller.addTester);

module.exports = router;
