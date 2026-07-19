const express = require('express');
const router = express.Router();
const adminController = require('./controllers.adminController');
const { requireAuth, requireAdmin } = require('./middleware.auth');

router.use(requireAuth, requireAdmin);

router.get('/stats', adminController.getStats);
router.get('/users', adminController.listUsers);
router.post('/users', adminController.createUser);
router.patch('/users/:id/plan', adminController.updatePlan);
router.patch('/users/:id/active', adminController.setActive);
router.delete('/users/:id', adminController.deleteUser);

module.exports = router;
