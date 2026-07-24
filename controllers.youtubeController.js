const { google } = require('googleapis');
const { getYoutubeOAuth2Client } = require('./services.tokenService');
const env = require('./config.env');
const YoutubeToken = require('./models.YoutubeToken');
const Log = require('./models.Log');

function getAuthUrl(req, res) {
  const oAuth2Client = getYoutubeOAuth2Client();
  const url = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account', // always show account picker so a different login can be chosen each time
    scope: env.google.youtubeScopes,
    state: req.user.id,
  });
  res.json({ success: true, data: { url } });
}

async function handleCallback(req, res, next) {
  try {
    const { code, state } = req.query;
    const userId = state;
    const oAuth2Client = getYoutubeOAuth2Client();
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
    const profile = await oauth2.userinfo.get();

    let channelTitle = null;
    try {
      const youtube = google.youtube({ version: 'v3', auth: oAuth2Client });
      const channelResp = await youtube.channels.list({ part: ['snippet'], mine: true });
      channelTitle = channelResp.data.items?.[0]?.snippet?.title || null;
    } catch (e) {
      // Non-fatal: we can still store the connection without a display name
    }

    await YoutubeToken.upsert(userId, {
      googleUserId: profile.data.id,
      googleUserEmail: profile.data.email,
      channelTitle,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiryTime: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      scope: tokens.scope,
    });

    await Log.record(userId, 'YouTube Channel Connected', { channelTitle, email: profile.data.email });
    res.redirect(`${env.frontendUrl}/drive.html?youtube_connected=1`);
  } catch (err) {
    next(err);
  }
}

async function listAccounts(req, res, next) {
  try {
    const accounts = await YoutubeToken.listByUser(req.user.id);
    res.json({ success: true, data: accounts });
  } catch (err) {
    next(err);
  }
}

async function disconnect(req, res, next) {
  try {
    await YoutubeToken.remove(req.user.id, req.params.id);
    await Log.record(req.user.id, 'YouTube Channel Disconnected', {});
    res.json({ success: true, message: 'YouTube channel disconnected' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAuthUrl, handleCallback, listAccounts, disconnect };
