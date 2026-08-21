/**
 * Public "Become a Tester" flow.
 * Anyone with the link can log in with Facebook (public_profile only - no
 * advanced permissions, no App Review needed) and get added as a Tester on
 * this app automatically, via Facebook's own documented Roles API
 * (POST /{app-id}/roles) - the same thing the App Dashboard's "Add People"
 * screen does, just triggered from our own page instead of developers.facebook.com.
 * Deliberately separate from controllers.facebookController.js (Page-connect
 * flow) - different scope, different redirect URI, no shared state.
 */
const axios = require('axios');
const crypto = require('crypto');
const env = require('./config.env');
const logger = require('./utils.logger');

const GRAPH_URL = `https://graph.facebook.com/${env.facebook.graphVersion}`;

function startAuth(req, res) {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('bt_state', state, { httpOnly: true, maxAge: 5 * 60 * 1000, sameSite: 'lax' });

  const params = new URLSearchParams({
    client_id: env.facebook.appId,
    redirect_uri: env.facebook.becomeTesterRedirectUri,
    config_id: env.facebook.becomeTesterConfigId, // Facebook Login for Business requires a Login Configuration, not a raw scope list
    state,
    response_type: 'code',
  });
  res.redirect(`https://www.facebook.com/${env.facebook.graphVersion}/dialog/oauth?${params}`);
}

function renderResult({ ok, title, message }) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; background:#0b0b0f; color:#eaeaea; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:24px; }
  .card { max-width:420px; text-align:center; background:#16161c; border:1px solid #2a2a2a; border-radius:12px; padding:32px 24px; }
  h1 { font-size:20px; margin:0 0 12px; color:${ok ? '#22c55e' : '#f87171'}; }
  p { color:#a3a3a3; line-height:1.5; }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

async function handleCallback(req, res) {
  try {
    const { code, state, error: fbError } = req.query;

    if (fbError) {
      return res.status(400).send(renderResult({ ok: false, title: 'Login cancelled', message: 'You cancelled the Facebook login, so nothing was added.' }));
    }
    if (!state || state !== req.cookies.bt_state) {
      return res.status(400).send(renderResult({ ok: false, title: 'Session expired', message: 'Please go back and try the Login with Facebook button again.' }));
    }
    res.clearCookie('bt_state');

    const tokenResp = await axios.get(`${GRAPH_URL}/oauth/access_token`, {
      params: {
        client_id: env.facebook.appId,
        client_secret: env.facebook.appSecret,
        redirect_uri: env.facebook.becomeTesterRedirectUri,
        code,
      },
    });

    const meResp = await axios.get(`${GRAPH_URL}/me`, {
      params: { access_token: tokenResp.data.access_token, fields: 'id,name' },
    });
    const { id: fbUserId, name } = meResp.data;

    const appAccessToken = `${env.facebook.appId}|${env.facebook.appSecret}`;
    await axios.post(`${GRAPH_URL}/${env.facebook.appId}/roles`, null, {
      params: { user: fbUserId, role: 'testers', access_token: appAccessToken },
    });

    logger.info(`Added Facebook user ${fbUserId} (${name}) as a tester`);
    res.send(renderResult({ ok: true, title: `You're in, ${name}!`, message: 'Your Facebook account has been added as a tester on the app. You can close this page.' }));
  } catch (err) {
    const fbMessage = err.response?.data?.error?.message;
    logger.error(`Become-tester callback failed: ${fbMessage || err.message}`);
    res.status(500).send(
      renderResult({
        ok: false,
        title: 'Something went wrong',
        message: fbMessage || 'Could not add you as a tester. You may already be one, or the link may have expired - try again.',
      })
    );
  }
}

module.exports = { startAuth, handleCallback };
