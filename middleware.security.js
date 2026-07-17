const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const csurf = require('csurf');
const env = require('./config.env');

function applySecurity(app) {
  app.use(helmet());

  app.use(
    cors({
      origin: env.frontendUrl,
      credentials: true,
    })
  );

  const limiter = rateLimit({
    windowMs: env.rateLimit.windowMs,
    max: env.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/', limiter);
}

// CSRF protection - applied selectively to state-changing routes that use cookie auth
const csrfProtection = csurf({ cookie: true });

module.exports = { applySecurity, csrfProtection };
