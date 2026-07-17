const axios = require('axios');
const env = require('./config.env');
const FacebookToken = require('./models.FacebookToken');
const facebookService = require('./services.facebookService');
const Page = require('./models.Page');
const Log = require('./models.Log');

const GRAPH_URL = `https://graph.facebook.com/${env.facebook.graphVersion}`;

function getAuthUrl(req, res) {
  const params = new URLSearchParams({
    client_id: env.facebook.appId,
    redirect_uri: env.facebook.redirectUri,
    scope: env.facebook.scopes.join(','),
    state: req.user.id,
    response_type: 'code',
  });
  res.json({ success: true, data: { url: `https://www.facebook.com/${env.facebook.graphVersion}/dialog/oauth?${params}` } });
}

async function handleCallback(req, res, next) {
  try {
    const { code, state } = req.query;
    const userId = state;

    const tokenResp = await axios.get(`${GRAPH_URL}/oauth/access_token`, {
      params: {
        client_id: env.facebook.appId,
        client_secret: env.facebook.appSecret,
        redirect_uri: env.facebook.redirectUri,
        code,
      },
    });

    const { access_token, expires_in } = tokenResp.data;

    const meResp = await axios.get(`${GRAPH_URL}/me`, { params: { access_token, fields: 'id,name,email' } });

    const expiryTime = expires_in ? new Date(Date.now() + expires_in * 1000) : null;
    await FacebookToken.upsert(userId, { accessToken: access_token, expiryTime, fbUserId: meResp.data.id });

    // Immediately sync pages
    const pages = await facebookService.getUserPages(userId);
    await Page.upsertMany(userId, pages);

    await Log.record(userId, 'Facebook Authorized', { pageCount: pages.length });
    res.redirect(`${env.frontendUrl}/dashboard.html?facebook_connected=1`);
  } catch (err) {
    next(err);
  }
}

async function disconnect(req, res, next) {
  try {
    await FacebookToken.remove(req.user.id);
    await Log.record(req.user.id, 'Facebook Disconnected', {});
    res.json({ success: true, message: 'Facebook account disconnected' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAuthUrl, handleCallback, disconnect };
