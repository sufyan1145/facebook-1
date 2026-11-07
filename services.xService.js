/**
 * X (Twitter) posting through the user's own browser cookies (auth_token + ct0).
 *
 * This uses X's internal web API (the same calls x.com makes in the browser), NOT the
 * paid official API. It is isolated in this file: nothing else in the app depends on it,
 * and a failure here can never break Facebook / YouTube / website publishing.
 *
 * Things that change on X's side from time to time are env-overridable:
 *   X_WEB_BEARER            public web-app bearer token
 *   X_CREATETWEET_QUERY_ID  GraphQL queryId of CreateTweet (auto-discovered if not set)
 */
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const logger = require('./utils.logger');
const XAccount = require('./models.XAccount');

// Optional residential/mobile proxy (X blocks many datacenter IPs as "automated", error 226):
//   X_PROXY_URL=http://user:pass@host:port
function proxyConfig() {
  if (!process.env.X_PROXY_URL) return {};
  try {
    const { HttpsProxyAgent } = require('https-proxy-agent');
    return { httpsAgent: new HttpsProxyAgent(process.env.X_PROXY_URL), proxy: false };
  } catch (err) { logger.warn(`[x] X_PROXY_URL ignored: ${err.message}`); return {}; }
}
const http = axios.create(proxyConfig());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const WEB_BEARER = process.env.X_WEB_BEARER ||
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FALLBACK_QUERY_ID = 'bDE2rBtZb3uyrczSZ_pI9g';
const TWEET_LIMIT = 280;
const URL_WEIGHT = 23; // X counts every link as 23 characters

const FEATURES = {
  communities_web_enable_tweet_composer_ui_enabled: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  articles_preview_enabled: true,
  rweb_video_timestamps_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

// ---- cookie parsing -----------------------------------------------------------
// Accepts: separate auth_token / ct0 values, a "auth_token=..; ct0=.." cookie string,
// or a JSON export from a cookie extension ([{name, value}, ...]).
function parseCookies({ authToken, ct0, cookies }) {
  let a = String(authToken || '').trim();
  let c = String(ct0 || '').trim();
  const raw = String(cookies || '').trim();
  if (raw) {
    try {
      const j = JSON.parse(raw);
      const list = Array.isArray(j) ? j : (Array.isArray(j.cookies) ? j.cookies : []);
      for (const it of list) {
        if (it && it.name === 'auth_token' && !a) a = String(it.value || '').trim();
        if (it && it.name === 'ct0' && !c) c = String(it.value || '').trim();
      }
    } catch (_) {
      const m1 = raw.match(/auth_token=([^;\s]+)/); const m2 = raw.match(/ct0=([^;\s]+)/);
      if (m1 && !a) a = m1[1]; if (m2 && !c) c = m2[1];
    }
  }
  a = a.replace(/^["']|["']$/g, ''); c = c.replace(/^["']|["']$/g, '');
  if (!a) throw new Error('The auth_token cookie is required.');
  if (/\s/.test(a + c)) throw new Error('The cookie values must not contain spaces.');
  return { authToken: a, ct0: c }; // ct0 is optional - it is fetched automatically when empty
}

// ct0 is only X's CSRF cookie. With just auth_token we ask x.com for a fresh one
// (it comes back in Set-Cookie); if X does not hand one out we make our own - X only
// checks that the cookie and the x-csrf-token header carry the same value.
async function fetchCt0(authToken) {
  try {
    const r = await http.get('https://x.com/', {
      headers: { 'user-agent': UA, cookie: `auth_token=${authToken}` }, timeout: 20000, validateStatus: () => true,
    });
    const found = [].concat(r.headers['set-cookie'] || []).map((c) => String(c).match(/(?:^|\s)ct0=([^;]+)/)).find(Boolean);
    if (found && found[1]) return found[1];
  } catch (err) { logger.warn(`[x] ct0 fetch failed: ${err.message}`); }
  return require('crypto').randomBytes(16).toString('hex');
}

function headers(acc, extra = {}) {
  return {
    authorization: `Bearer ${WEB_BEARER}`,
    cookie: `auth_token=${acc.auth_token}; ct0=${acc.ct0}`,
    'x-csrf-token': acc.ct0,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'user-agent': UA,
    origin: 'https://x.com',
    referer: 'https://x.com/home',
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    ...extra,
  };
}

function xError(err) {
  const status = err.response && err.response.status;
  const d = err.response && err.response.data;
  const apiMsg = (d && d.errors && d.errors[0] && (d.errors[0].message || d.errors[0].code)) || (d && d.error) || null;
  const e = new Error(
    status === 401 || status === 403 && !apiMsg ? 'X rejected the cookies (expired or logged out). Add the account again with fresh cookies.'
      : status === 429 ? 'X rate limit reached. Try again later.'
      : String(apiMsg || err.message).slice(0, 300)
  );
  e.xCode = d && d.errors && d.errors[0] ? d.errors[0].code : undefined;
  e.expired = status === 401 || (d && d.errors && d.errors.some((x) => x.code === 32 || x.code === 89 || x.code === 215));
  e.status = status;
  return e;
}

// ---- x-client-transaction-id ---------------------------------------------------
// X now rejects most internal API calls (404 "page does not exist") unless this header is
// present. It is generated from x.com's home page by the "x-client-transaction-id" package.
// If the package is missing or X changes again, calls go out without it (and fail clearly).
let txPromise = null; let txAt = 0;
let txStatus = 'not tried yet';
function getTransactionGenerator() {
  if (txPromise && Date.now() - txAt < 20 * 60 * 1000) return txPromise;
  txAt = Date.now();
  txPromise = (async () => {
    let lib;
    try { lib = require('x-client-transaction-id'); }
    catch (_) { txStatus = 'package x-client-transaction-id is NOT installed (run npm install / rebuild)'; logger.warn(`[x] ${txStatus}`); return null; }
    const doc = lib.handleXMigration ? await lib.handleXMigration() : await lib.fetchXDocument();
    let ct;
    if (typeof lib.ClientTransaction.create === 'function') ct = await lib.ClientTransaction.create(doc);
    else { ct = new lib.ClientTransaction(doc); if (typeof ct.initialize === 'function') await ct.initialize(); }
    txStatus = 'ok';
    return ct;
  })().catch((err) => { txStatus = `setup failed: ${String(err.message).slice(0, 120)}`; logger.warn(`[x] transaction-id ${txStatus}`); txPromise = null; return null; });
  return txPromise;
}

async function txHeader(method, url) {
  const ct = await getTransactionGenerator();
  if (!ct) return {};
  try {
    return { 'x-client-transaction-id': await ct.generateTransactionId(String(method).toUpperCase(), new URL(url).pathname) };
  } catch (err) {
    txStatus = `generate failed: ${String(err.message).slice(0, 120)}`;
    logger.warn(`[x] transaction-id ${txStatus}`);
    return {};
  }
}

// ---- verify -------------------------------------------------------------------
// X moves/removes internal endpoints now and then (a 404 "page does not exist" just means
// THIS endpoint is gone), so several are tried in order. A 401/403 means bad cookies and stops.
const VERIFY_ENDPOINTS = [
  'https://api.x.com/1.1/account/settings.json',
  'https://api.twitter.com/1.1/account/settings.json',
  'https://x.com/i/api/1.1/account/settings.json',
  'https://api.x.com/1.1/account/verify_credentials.json',
  'https://x.com/i/api/1.1/account/verify_credentials.json',
];

async function verify({ authToken, ct0 }) {
  ct0 = ct0 || await fetchCt0(authToken);
  const acc = { auth_token: authToken, ct0 };
  let lastErr = null;
  for (const url of VERIFY_ENDPOINTS) {
    try {
      const { data } = await http.get(url, { headers: headers(acc, await txHeader('GET', url)), timeout: 20000, params: { include_ext_sharing_audiospaces_listening_data_with_followers: true } });
      const username = data && data.screen_name;
      if (!username) { lastErr = new Error('Could not read the account name from X.'); continue; }
      let displayName = null; let xUserId = null;
      try {
        const vcUrl = 'https://api.x.com/1.1/account/verify_credentials.json';
        const r = await http.get(vcUrl, { headers: headers(acc, await txHeader('GET', vcUrl)), timeout: 20000 });
        displayName = r.data && r.data.name; xUserId = r.data && r.data.id_str;
      } catch (_) { /* optional */ }
      return { username, displayName, xUserId, ct0 };
    } catch (err) {
      if (!err.response) throw err;
      const status = err.response.status;
      if (status === 404) { lastErr = xError(err); continue; }
      throw xError(err);
    }
  }
  const e = new Error(`X did not answer on any known endpoint (${lastErr && lastErr.message ? lastErr.message : 'no reply'}) [transaction-id: ${txStatus}]`);
  e.endpointGone = true; // cookies were not rejected - X just changed its endpoints
  throw e;
}

// ---- GraphQL queryId (changes when X ships a new web build) ---------------------
let cachedQueryId = null; let cachedAt = 0;
async function discoverQueryId(acc) {
  if (process.env.X_CREATETWEET_QUERY_ID) return process.env.X_CREATETWEET_QUERY_ID;
  if (cachedQueryId && Date.now() - cachedAt < 6 * 3600 * 1000) return cachedQueryId;
  try {
    const home = await http.get('https://x.com/', { headers: { 'user-agent': UA, cookie: `auth_token=${acc.auth_token}; ct0=${acc.ct0}` }, timeout: 20000 });
    const scripts = [...String(home.data).matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"']*?\/main\.[a-z0-9]+\.js/g)].map((m) => m[0]);
    for (const url of scripts) {
      const js = (await http.get(url, { timeout: 30000 })).data;
      const m = String(js).match(/queryId:"([A-Za-z0-9_-]+)",operationName:"CreateTweet"/);
      if (m) { cachedQueryId = m[1]; cachedAt = Date.now(); return cachedQueryId; }
    }
  } catch (err) { logger.warn(`[x] queryId discovery failed: ${err.message}`); }
  return cachedQueryId || FALLBACK_QUERY_ID;
}

// ---- media ----------------------------------------------------------------------
async function uploadImage(acc, filePath) {
  const buf = fs.readFileSync(filePath);
  const mime = /\.png$/i.test(filePath) ? 'image/png' : 'image/jpeg';
  const base = 'https://upload.x.com/i/media/upload.json';
  const h = headers(acc);
  const init = await http.post(base, null, { headers: h, timeout: 30000,
    params: { command: 'INIT', total_bytes: buf.length, media_type: mime, media_category: 'tweet_image' } });
  const mediaId = init.data.media_id_string;
  const form = new FormData();
  form.append('media', buf, { filename: 'blob', contentType: 'application/octet-stream' });
  await http.post(base, form, { headers: { ...h, ...form.getHeaders() }, timeout: 120000, maxBodyLength: Infinity,
    params: { command: 'APPEND', media_id: mediaId, segment_index: 0 } });
  await http.post(base, null, { headers: h, timeout: 30000, params: { command: 'FINALIZE', media_id: mediaId } });
  return mediaId;
}

// The tweet id sits under create_tweet.tweet_results.result.rest_id (sometimes one level deeper).
function findRestId(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (node.rest_id && /^\d+$/.test(String(node.rest_id))) return String(node.rest_id);
  for (const k of Object.keys(node)) {
    const f = findRestId(node[k], depth + 1);
    if (f) return f;
  }
  return null;
}

// Keep the tweet inside 280 chars: the link always counts 23, the text is trimmed.
function fitTweet(text, url) {
  const budget = TWEET_LIMIT - (url ? URL_WEIGHT + 2 : 0);
  let t = String(text || '').trim();
  if (t.length > budget) t = t.slice(0, budget - 1).replace(/\s+\S*$/, '') + '…';
  return url ? `${t}\n\n${url}` : t;
}

// ---- post -------------------------------------------------------------------------
async function postTweet(account, opts) {
  try {
    return await postTweetOnce(account, opts);
  } catch (err) {
    if (err.status !== 403 || err.expired || err.xCode === 226) throw err;
    // ct0 may simply be stale: get a new one, save it, try once more
    const fresh = await fetchCt0(account.auth_token);
    await XAccount.setCt0(account.id, fresh);
    return postTweetOnce({ ...account, ct0: fresh }, opts);
  }
}

async function postTweetOnce(account, { text, url, imagePaths = [], replyTo = null }) {
  const acc = { ...account };
  try {
    await sleep(1500 + Math.floor(Math.random() * 3500)); // small human-like pause
    const mediaIds = [];
    for (const p of imagePaths.slice(0, 4)) {
      try { mediaIds.push(await uploadImage(acc, p)); }
      catch (err) { logger.warn(`[x] image upload skipped: ${err.response ? xError(err).message : err.message}`); }
    }
    const queryId = await discoverQueryId(acc);
    const body = {
      variables: {
        tweet_text: fitTweet(text, url), dark_request: false,
        media: { media_entities: mediaIds.map((id) => ({ media_id: id, tagged_users: [] })), possibly_sensitive: false },
        semantic_annotation_ids: [],
        ...(replyTo ? { reply: { in_reply_to_tweet_id: String(replyTo), exclude_reply_user_ids_in_text: false } } : {}),
      },
      features: FEATURES, queryId,
    };
    const ctUrl = `https://x.com/i/api/graphql/${queryId}/CreateTweet`;
    const { data } = await http.post(ctUrl, body, {
      headers: headers(acc, { 'content-type': 'application/json', ...(await txHeader('POST', ctUrl)) }), timeout: 30000,
    });
    if (data && data.errors && data.errors.length) {
      const e = new Error(String(data.errors[0].message || 'X refused the post').slice(0, 300));
      e.xCode = data.errors[0].code;
      e.expired = data.errors.some((x) => x.code === 32 || x.code === 89);
      throw e;
    }
    const created = data && data.data && data.data.create_tweet;
    const id = findRestId(created);
    if (!id) {
      const raw = JSON.stringify(data).slice(0, 300);
      logger.warn(`[x] CreateTweet gave no tweet id for @${account.username} (text ${body.variables.tweet_text.length} chars, ${mediaIds.length} image(s)): ${raw}`);
      throw new Error(`X did not confirm the post (reply: ${raw})`);
    }
    await XAccount.markUsed(account.id);
    logger.info(`[x] posted tweet ${id} as @${account.username}`);
    return { id, url: `https://x.com/${account.username}/status/${id}` };
  } catch (err) {
    const e = err.response ? xError(err) : err;
    if (e.expired) await XAccount.markExpired(account.id, e.message);
    logger.error(`[x] post as @${account.username} failed: ${e.message}`);
    throw e;
  }
}

module.exports = { parseCookies, verify, postTweet, fitTweet, fetchCt0, TWEET_LIMIT };
