const express = require('express');
const router = express.Router();
const authController = require('./controllers.authController');
const { requireAuth } = require('./middleware.auth');
const { registerRules, loginRules, handleValidation } = require('./utils.validators');

router.post('/register', registerRules, handleValidation, authController.register);
router.post('/login', loginRules, handleValidation, authController.login);
router.post('/logout', requireAuth, authController.logout);
router.get('/verify-email', authController.verifyEmail);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password', authController.resetPassword);
router.get('/me', requireAuth, authController.me);

module.exports = router;
