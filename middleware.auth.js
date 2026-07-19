const jwt = require('jsonwebtoken');
const env = require('./config.env');
const User = require('./models.User');

async function requireAuth(req, res, next) {
  try {
    const token =
      (req.cookies && req.cookies.access_token) ||
      (req.headers.authorization && req.headers.authorization.replace('Bearer ', ''));

    if (!token) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const decoded = jwt.verify(token, env.jwt.secret);
    const user = await User.findById(decoded.sub);
    if (!user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }

    if (user.is_active === false) {
      return res.status(403).json({ success: false, message: 'This account has been deactivated. Please contact support.' });
    }

    if (user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) {
      return res.status(403).json({ success: false, message: 'Your plan has expired. Please contact us to renew.' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: !!user.is_admin,
      planType: user.plan_type,
      planExpiresAt: user.plan_expires_at,
    };
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  next();
}

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, env.jwt.secret, {
    expiresIn: env.jwt.expiresIn,
  });
}

function signRefreshToken(user) {
  return jwt.sign({ sub: user.id }, env.jwt.refreshSecret, {
    expiresIn: env.jwt.refreshExpiresIn,
  });
}

module.exports = { requireAuth, requireAdmin, signAccessToken, signRefreshToken };
