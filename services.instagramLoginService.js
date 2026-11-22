/**
 * Instagram API with Instagram Login (official OAuth, no Facebook Page needed).
 * Connect: Instagram login -> long-lived token (60 days, renewed automatically).
 * Post: Reels from a public video URL (the web app hosts it briefly, see services.mediaHostService.js).
 */
const axios = require('axios');
const crypto = require('crypto');
const env = require('./config.env');
const InstagramAccount = require('./models.InstagramAccount');
const logger = require('./utils.logger');

const GRAPH = 'https://graph.instagram.com/v21.0';
const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 8 * 60 * 1000;

const appId = () => (process.env.INSTAGRAM_APP_ID || '').trim();
const appSecret = () => (process.env.INSTAGRAM_APP_SECRET || '').trim();
const redirectUri = () => (process.env.INSTAGRAM_REDIRECT_URI || `${String(env.appUrl).replace(/\/+$/, '')}/api/instagram/callback`).trim();
const configured = () => !!(appId() && appSecret());

function igError(err) {
  const d = err.response && err.response.data;
  const m = d && ((d.error && (d.error.error_user_msg || d.error.message)) || d.error_message || d.message);
  const e = new Error(String(m || err.message));
  e.status = err.response && err.response.status;
  e.igCode = d && d.error && d.error.code;
  return e;
}

// ---- signed OAuth "state" (carries the user id, valid 15 minutes) ----
const sign = (s) => crypto.createHmac('sha256', String(env.tokenEncryptionKey || 'k')).update(`ig:${s}`).digest('hex').slice(0, 32);
function makeState(userId) { const p = `${userId}.${Date.now()}`; return `${p}.${sign(p)}`; }
function readState(state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return null;
  const p = `${parts[0]}.${parts[1]}`;
  if (sign(p) !== parts[2] || Date.now() - Number(parts[1]) > 15 * 60 * 1000) return null;
  return parts[0];
}

function authUrl(userId) {
  if (!configured()) throw new Error('Instagram is not set up: add INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET to the server settings.');
  const q = new URLSearchParams({ client_id: appId(), redirect_uri: redirectUri(), scope: SCOPES.join(','), response_type: 'code', state: makeState(userId) });
  return `https://www.instagram.com/oauth/authorize?${q.toString()}`;
}

// code -> short-lived token -> long-lived token (60 days)
async function exchangeCode(code) {
  try {
    const short = await axios.post('https://api.instagram.com/oauth/access_token', new URLSearchParams({
      client_id: appId(), client_secret: appSecret(), grant_type: 'authorization_code', redirect_uri: redirectUri(), code: String(code || '').replace(/#_$/, ''),
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
    const s = (short.data && short.data.data && short.data.data[0]) || short.data;
    const long = await axios.get('https://graph.instagram.com/access_token', {
      params: { grant_type: 'ig_exchange_token', client_secret: appSecret(), access_token: s.access_token }, timeout: 30000,
    });
    const expiresIn = Number(long.data.expires_in) || 60 * 24 * 3600;
    return { accessToken: long.data.access_token, igUserId: s.user_id ? String(s.user_id) : null, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  } catch (err) { throw igError(err); }
}

async function profile(accessToken) {
  try {
    const { data } = await axios.get(`${GRAPH}/me`, { params: { fields: 'user_id,username,account_type', access_token: accessToken }, timeout: 30000 });
    return { id: String(data.user_id || data.id), username: data.username, accountType: data.account_type };
  } catch (err) { throw igError(err); }
}

// A valid token for the account; renews it when it has less than 10 days left.
async function tokenFor(acc) {
  const left = acc.expires_at ? new Date(acc.expires_at).getTime() - Date.now() : Infinity;
  if (left > 10 * 24 * 3600 * 1000) return acc.access_token;
  try {
    const { data } = await axios.get('https://graph.instagram.com/refresh_access_token', { params: { grant_type: 'ig_refresh_token', access_token: acc.access_token }, timeout: 30000 });
    const exp = new Date(Date.now() + (Number(data.expires_in) || 60 * 24 * 3600) * 1000);
    await InstagramAccount.setToken(acc.id, data.access_token, exp);
    return data.access_token;
  } catch (err) {
    if (left > 0) return acc.access_token;
    await InstagramAccount.markExpired(acc.id, `Login expired: ${igError(err).message}`);
    throw new Error('The Instagram login expired. Open Social Accounts and add this Instagram account again.');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Posts a Reel. videoUrl must be publicly reachable. Returns the published media id. */
async function publishReel(acc, { videoUrl, caption }) {
  const token = await tokenFor(acc);
  let creationId;
  try {
    const r = await axios.post(`${GRAPH}/${acc.ig_user_id}/media`, null, {
      params: { media_type: 'REELS', video_url: videoUrl, caption: String(caption || '').slice(0, 2200), share_to_feed: true, access_token: token }, timeout: 60000,
    });
    creationId = r.data.id;
  } catch (err) {
    const e = igError(err);
    if (e.status === 401 || e.igCode === 190) await InstagramAccount.markExpired(acc.id, e.message);
    throw new Error(`Instagram container creation failed: ${e.message}`);
  }
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    if (Date.now() > deadline) throw new Error('Instagram video processing did not finish in time.');
    await sleep(POLL_INTERVAL_MS);
    let st;
    try { st = (await axios.get(`${GRAPH}/${creationId}`, { params: { fields: 'status_code,status', access_token: token }, timeout: 30000 })).data; }
    catch (err) { throw new Error(`Instagram status check failed: ${igError(err).message}`); }
    if (st.status_code === 'FINISHED') break;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`Instagram rejected the video (${st.status_code}): ${st.status || 'no detail'}`);
  }
  try {
    const p = await axios.post(`${GRAPH}/${acc.ig_user_id}/media_publish`, null, { params: { creation_id: creationId, access_token: token }, timeout: 60000 });
    await InstagramAccount.markUsed(acc.id);
    logger.info(`[instagram-login] @${acc.username}: reel published ${p.data.id}`);
    return p.data.id;
  } catch (err) { throw new Error(`Instagram publish failed: ${igError(err).message}`); }
}

module.exports = { configured, authUrl, readState, exchangeCode, profile, publishReel, redirectUri };
