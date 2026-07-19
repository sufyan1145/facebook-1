const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const User = require('./models.User');
const Log = require('./models.Log');
const { signAccessToken, signRefreshToken } = require('./middleware.auth');
const { sendVerificationEmail, sendPasswordResetEmail } = require('./services.emailService');
const env = require('./config.env');

const cookieOpts = {
  httpOnly: true,
  secure: env.nodeEnv === 'production',
  sameSite: 'lax',
};

async function register(req, res, next) {
  // Public self-registration is disabled. Accounts are created manually by the
  // admin (see create-user.js) so that access can be tied to payment.
  return res.status(403).json({
    success: false,
    message: 'Public registration is closed. Please contact us to get an account.',
  });
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;
    const user = await User.findByEmail(email);
    if (!user || !user.password_hash) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ success: false, message: 'Invalid email or password' });

    if (user.is_active === false) {
      return res.status(403).json({ success: false, message: 'This account has been deactivated. Please contact support.' });
    }
    if (user.plan_expires_at && new Date(user.plan_expires_at) < new Date()) {
      return res.status(403).json({ success: false, message: 'Your plan has expired. Please contact us to renew your access.' });
    }

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);

    await User.touchLastLogin(user.id);

    res
      .cookie('access_token', accessToken, { ...cookieOpts, maxAge: 7 * 24 * 60 * 60 * 1000 })
      .cookie('refresh_token', refreshToken, { ...cookieOpts, maxAge: 30 * 24 * 60 * 60 * 1000 })
      .json({
        success: true,
        data: {
          accessToken,
          user: { id: user.id, name: user.name, email: user.email, isAdmin: !!user.is_admin },
        },
      });

    await Log.record(user.id, 'User Logged In', {});
  } catch (err) {
    next(err);
  }
}

async function logout(req, res) {
  res.clearCookie('access_token').clearCookie('refresh_token').json({ success: true, message: 'Logged out' });
}

async function verifyEmail(req, res, next) {
  try {
    const { token } = req.query;
    const result = await require('./config.database').query(
      'SELECT * FROM users WHERE email_verify_token = $1',
      [token]
    );
    const user = result.rows[0];
    if (!user) return res.status(400).send('Invalid or expired verification link.');

    await User.setEmailVerified(user.id);
    res.redirect(`${env.frontendUrl}/login.html?verified=1`);
  } catch (err) {
    next(err);
  }
}

async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    const user = await User.findByEmail(email);
    // Always respond success to avoid leaking which emails are registered
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000);
      await User.setPasswordResetToken(user.id, token, expires);
      await sendPasswordResetEmail(user, token);
      await Log.record(user.id, 'Password Reset Requested', {});
    }
    res.json({ success: true, message: 'If that email is registered, a reset link has been sent.' });
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const { token, password } = req.body;
    const user = await User.findByResetToken(token);
    if (!user) return res.status(400).json({ success: false, message: 'Invalid or expired reset token' });

    const passwordHash = await bcrypt.hash(password, 12);
    await User.updatePassword(user.id, passwordHash);
    await Log.record(user.id, 'Password Reset', {});

    res.json({ success: true, message: 'Password reset successful' });
  } catch (err) {
    next(err);
  }
}

async function me(req, res, next) {
  try {
    const user = await User.findById(req.user.id);
    res.json({
      success: true,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        timezone: user.timezone,
        language: user.language,
        isAdmin: !!user.is_admin,
        planType: user.plan_type,
        planExpiresAt: user.plan_expires_at,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, logout, verifyEmail, forgotPassword, resetPassword, me };
