const express = require('express');
const router = express.Router();
const scheduleController = require('./controllers.scheduleController');
const { requireAuth } = require('./middleware.auth');
const { scheduleRules, idParamRule, handleValidation } = require('./utils.validators');

router.post('/', requireAuth, scheduleRules, handleValidation, scheduleController.createSchedule);
router.get('/', requireAuth, scheduleController.listSchedules);
router.patch('/:id/toggle', requireAuth, idParamRule, handleValidation, scheduleController.toggleSchedule);
router.delete('/:id', requireAuth, idParamRule, handleValidation, scheduleController.deleteSchedule);

module.exports = router;
