const { getOAuth2Client } = require('./services.tokenService');
const { google } = require('googleapis');
const env = require('./config.env');
const GoogleToken = require('./models.GoogleToken');
const User = require('./models.User');
const Log = require('./models.Log');

function getAuthUrl(req, res) {
  const oAuth2Client = getOAuth2Client();
  const url = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: env.google.scopes,
    state: req.user.id,
  });
  res.json({ success: true, data: { url } });
}

async function handleCallback(req, res, next) {
  try {
    const { code, state } = req.query;
    const userId = state;
    const oAuth2Client = getOAuth2Client();
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    await GoogleToken.upsert(userId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryTime: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      scope: tokens.scope,
    });

    // Link google id / profile if not already
    const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
    const profile = await oauth2.userinfo.get();
    await User.updateProfile(userId, { avatarUrl: profile.data.picture });

    await Log.record(userId, 'User Connected Drive', {});
    res.redirect(`${env.frontendUrl}/dashboard.html?drive_connected=1`);
  } catch (err) {
    next(err);
  }
}

async function disconnect(req, res, next) {
  try {
    await GoogleToken.remove(req.user.id);
    await Log.record(req.user.id, 'Drive Disconnected', {});
    res.json({ success: true, message: 'Google Drive disconnected' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAuthUrl, handleCallback, disconnect };
