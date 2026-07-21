const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const env = require('./config.env');
const logger = require('./utils.logger');
const { applySecurity } = require('./middleware.security');
const { notFound, errorHandler } = require('./middleware.errorHandler');

const app = express();

// Railway (and most PaaS platforms) sit behind a reverse proxy that sets
// X-Forwarded-For. Without this, express-rate-limit throws a validation
// error on every request instead of rate-limiting by real client IP.
app.set('trust proxy', 1);

// API responses must never be cached by the browser — disable Express's
// automatic ETag generation and explicitly set no-store on every /api response.
// Without this, GET requests (like the Drive folder scan) can return a stale
// cached 304 response instead of running the handler again.
app.set('etag', false);
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser(env.cookieSecret));
applySecurity(app);

// Serve the vanilla JS frontend
app.use(express.static(path.join(__dirname, 'public')));

// API routes
app.use('/api/auth', require('./routes.auth'));
app.use('/api/auth/google', require('./routes.google'));
app.use('/api/auth/facebook', require('./routes.facebook'));
app.use('/api/drive', require('./routes.drive'));
app.use('/api/folder-mapping', require('./routes.folderMapping'));
app.use('/api/pages', require('./routes.pages'));
app.use('/api/schedules', require('./routes.schedules'));
app.use('/api/queue', require('./routes.queue'));
app.use('/api/uploads', require('./routes.uploads'));
app.use('/api/logs', require('./routes.logs'));
app.use('/api/settings', require('./routes.settings'));
app.use('/api/dashboard', require('./routes.dashboard'));
app.use('/api/notifications', require('./routes.notifications'));
app.use('/api/admin', require('./routes.admin'));
app.use('/api/videogen', require('./routes.videogen'));
app.use('/api/content-schedules', require('./routes.contentSchedule'));

app.get('/api/health', (req, res) => res.json({ success: true, message: 'OK' }));

app.use(notFound);
app.use(errorHandler);

app.listen(env.port, () => {
  logger.info(`Drive2Facebook Automation server running on port ${env.port} [${env.nodeEnv}]`);
});

module.exports = app;
