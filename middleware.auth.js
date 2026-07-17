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
    req.user = { id: user.id, email: user.email, name: user.name };
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
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

module.exports = { requireAuth, signAccessToken, signRefreshToken };
