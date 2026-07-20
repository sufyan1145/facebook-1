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
    auth_type: 'reauthenticate', // forces Facebook's login screen so a different account can be chosen
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
    const tokenRow = await FacebookToken.upsert(userId, {
      accessToken: access_token,
      expiryTime,
      fbUserId: meResp.data.id,
      fbUserName: meResp.data.name,
    });

    // Immediately sync this account's pages (existing pages from other connected accounts are untouched)
    const pages = await facebookService.getUserPages(userId, tokenRow.id);
    await Page.upsertMany(userId, tokenRow.id, pages);

    await Log.record(userId, 'Facebook Authorized', { fbUserName: meResp.data.name, pageCount: pages.length });
    res.redirect(`${env.frontendUrl}/dashboard.html?facebook_connected=1`);
  } catch (err) {
    next(err);
  }
}

async function listAccounts(req, res, next) {
  try {
    const accounts = await FacebookToken.listByUser(req.user.id);
    res.json({ success: true, data: accounts });
  } catch (err) {
    next(err);
  }
}

async function disconnect(req, res, next) {
  try {
    await FacebookToken.remove(req.user.id, req.params.id);
    await Log.record(req.user.id, 'Facebook Disconnected', { accountId: req.params.id });
    res.json({ success: true, message: 'Facebook account disconnected' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAuthUrl, handleCallback, listAccounts, disconnect };
