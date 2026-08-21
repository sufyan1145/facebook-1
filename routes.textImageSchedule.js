const express = require('express');
const router = express.Router();
const controller = require('./controllers.textImageScheduleController');
const { requireAuth } = require('./middleware.auth');
const { textImageScheduleRules, idParamRule, handleValidation } = require('./utils.validators');

router.post('/', requireAuth, textImageScheduleRules, handleValidation, controller.createSchedule);
router.get('/', requireAuth, controller.listSchedules);
router.patch('/:id/toggle', requireAuth, idParamRule, handleValidation, controller.toggleSchedule);
router.delete('/:id', requireAuth, idParamRule, handleValidation, controller.deleteSchedule);

module.exports = router;
