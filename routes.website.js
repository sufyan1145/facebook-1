const express = require('express');
const { requireAuth } = require('./middleware.auth');
const c = require('./controllers.websiteController');

const router = express.Router();
router.get('/accounts', requireAuth, c.listAccounts);
router.post('/accounts/wordpress/test', requireAuth, c.testWordPress);
router.post('/accounts/wordpress', requireAuth, c.addWordPress);
router.delete('/accounts/:id', requireAuth, c.removeAccount);
router.get('/blogger/connect', requireAuth, c.bloggerConnect);

router.get('/schedules', requireAuth, c.listSchedules);
router.post('/schedules', requireAuth, c.createSchedule);
router.put('/schedules/:id', requireAuth, c.updateSchedule);
router.patch('/schedules/:id/toggle', requireAuth, c.toggleSchedule);
router.delete('/schedules/:id', requireAuth, c.deleteSchedule);

router.get('/posts', requireAuth, c.listPosts);
router.post('/posts', requireAuth, c.writeNow);
router.post('/posts/:id/retry', requireAuth, c.retryPost);
router.post('/posts/:id/share', requireAuth, c.sharePost);
router.delete('/posts/:id', requireAuth, c.deletePost);

// Google redirects here after "Connect Blogger" (mounted at /api/auth/blogger).
const bloggerRouter = express.Router();
bloggerRouter.get('/callback', c.bloggerCallback);
router.bloggerRouter = bloggerRouter;

module.exports = router;
