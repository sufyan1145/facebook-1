const express = require('express');
const router = express.Router();
const controller = require('./controllers.contentScheduleController');
const { requireAuth } = require('./middleware.auth');

router.post('/', requireAuth, controller.create);
router.get('/', requireAuth, controller.list);
router.patch('/:id/toggle', requireAuth, controller.toggle);
router.delete('/:id', requireAuth, controller.remove);
router.get('/runs', requireAuth, controller.listRuns);

module.exports = router;
