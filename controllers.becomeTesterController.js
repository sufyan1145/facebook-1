/**
 * Public "Become a Tester" flow - manual ID input.
 * Originally attempted via a Facebook OAuth login dialog, but Facebook Login
 * for Business blocked EVERY new redirect_uri for this app with a generic
 * "Feature Unavailable / updating additional details" error, regardless of
 * scope or Login Configuration used - confirmed to be an app-level Facebook-side
 * restriction, not something fixable from our code. This manual-ID version
 * sidesteps the OAuth dialog entirely: the person just types their own
 * Facebook numeric ID, and we call Facebook's official Roles API
 * (POST /{app-id}/roles) directly - the same thing the App Dashboard's
 * "Add People" screen does, just triggered from our own page.
 */
const axios = require('axios');
const env = require('./config.env');
const logger = require('./utils.logger');

const GRAPH_URL = `https://graph.facebook.com/${env.facebook.graphVersion}`;

async function addTester(req, res) {
  const fbUserId = String(req.body.fbUserId || '').trim();

  if (!/^\d+$/.test(fbUserId)) {
    return res.status(400).json({ success: false, message: 'Please provide a valid numeric Facebook ID.' });
  }

  try {
    const appAccessToken = `${env.facebook.appId}|${env.facebook.appSecret}`;
    await axios.post(`${GRAPH_URL}/${env.facebook.appId}/roles`, null, {
      params: { user: fbUserId, role: 'testers', access_token: appAccessToken },
    });

    logger.info(`Added Facebook user ${fbUserId} as a tester (manual entry)`);
    res.json({ success: true });
  } catch (err) {
    const fbMessage = err.response?.data?.error?.message;
    logger.error(`Become-tester manual add failed for ${fbUserId}: ${fbMessage || err.message}`);
    res.status(500).json({
      success: false,
      message: fbMessage || 'Could not add this ID as a tester. Double-check the ID and try again.',
    });
  }
}

module.exports = { addTester };
