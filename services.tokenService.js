const { google } = require('googleapis');
const axios = require('axios');
const env = require('./config.env');
const GoogleToken = require('./models.GoogleToken');
const FacebookToken = require('./models.FacebookToken');
const YoutubeToken = require('./models.YoutubeToken');
const logger = require('./utils.logger');

function getOAuth2Client() {
  return new google.auth.OAuth2(env.google.clientId, env.google.clientSecret, env.google.redirectUri);
}

// Separate OAuth2 client/redirect for YouTube, since each connected channel is its
// own independent Google login (not the same account as the Drive connection).
function getYoutubeOAuth2Client() {
  return new google.auth.OAuth2(env.google.clientId, env.google.clientSecret, `${env.appUrl}/api/auth/youtube/callback`);
}

async function getValidYoutubeClient(userId, youtubeTokenId) {
  const tokenRow = await YoutubeToken.findById(userId, youtubeTokenId);
  if (!tokenRow) throw new Error('YouTube channel not connected');

  const oAuth2Client = getYoutubeOAuth2Client();
  oAuth2Client.setCredentials({
    access_token: tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expiry_date: tokenRow.expiry_time ? new Date(tokenRow.expiry_time).getTime() : undefined,
  });

  const isExpired = !tokenRow.expiry_time || new Date(tokenRow.expiry_time).getTime() - Date.now() < 60000;
  if (isExpired && tokenRow.refresh_token) {
    const { credentials } = await oAuth2Client.refreshAccessToken();
    oAuth2Client.setCredentials(credentials);
    await YoutubeToken.upsert(userId, {
      googleUserId: tokenRow.google_user_id,
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token || tokenRow.refresh_token,
      expiryTime: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
      scope: credentials.scope,
    });
    logger.info(`Refreshed YouTube token for user ${userId}, channel ${tokenRow.channel_title || tokenRow.google_user_id}`);
  }

  return oAuth2Client;
}

async function getValidGoogleClient(userId) {
  const tokenRow = await GoogleToken.findByUser(userId);
  if (!tokenRow) throw new Error('Google account not connected');

  const oAuth2Client = getOAuth2Client();
  oAuth2Client.setCredentials({
    access_token: tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expiry_date: tokenRow.expiry_time ? new Date(tokenRow.expiry_time).getTime() : undefined,
  });

  // Auto-refresh if expired/near expiry
  const isExpired = !tokenRow.expiry_time || new Date(tokenRow.expiry_time).getTime() - Date.now() < 60000;
  if (isExpired && tokenRow.refresh_token) {
    const { credentials } = await oAuth2Client.refreshAccessToken();
    oAuth2Client.setCredentials(credentials);
    await GoogleToken.upsert(userId, {
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token || tokenRow.refresh_token,
      expiryTime: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
      scope: credentials.scope,
    });
    logger.info(`Refreshed Google token for user ${userId}`);
  }

  return oAuth2Client;
}

async function getValidFacebookToken(userId, facebookTokenId) {
  const tokenRow = await FacebookToken.findById(userId, facebookTokenId);
  if (!tokenRow) throw new Error('Facebook account not connected');

  const isExpired = tokenRow.expiry_time && new Date(tokenRow.expiry_time).getTime() - Date.now() < 60000;
  if (isExpired) {
    // Exchange for a new long-lived token
    const resp = await axios.get(`https://graph.facebook.com/${env.facebook.graphVersion}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: env.facebook.appId,
        client_secret: env.facebook.appSecret,
        fb_exchange_token: tokenRow.access_token,
      },
    });
    const { access_token, expires_in } = resp.data;
    const expiryTime = expires_in ? new Date(Date.now() + expires_in * 1000) : null;
    await FacebookToken.upsert(userId, {
      accessToken: access_token,
      expiryTime,
      fbUserId: tokenRow.fb_user_id,
      fbUserName: tokenRow.fb_user_name,
    });
    logger.info(`Refreshed Facebook token for user ${userId}, account ${tokenRow.fb_user_id}`);
    return access_token;
  }

  return tokenRow.access_token;
}

module.exports = { getOAuth2Client, getYoutubeOAuth2Client, getValidGoogleClient, getValidYoutubeClient, getValidFacebookToken };
