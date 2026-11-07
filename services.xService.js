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
  if (!a || !c) throw new Error('Both auth_token and ct0 cookies are required.');
  if (/\s/.test(a + c)) throw new Error('The cookie values must not contain spaces.');
  return { authToken: a, ct0: c };
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
  e.expired = status === 401 || (d && d.errors && d.errors.some((x) => x.code === 32 || x.code === 89 || x.code === 215));
  e.status = status;
  return e;
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
  const acc = { auth_token: authToken, ct0 };
  let lastErr = null;
  for (const url of VERIFY_ENDPOINTS) {
    try {
      const { data } = await axios.get(url, { headers: headers(acc), timeout: 20000, params: { include_ext_sharing_audiospaces_listening_data_with_followers: true } });
      const username = data && data.screen_name;
      if (!username) { lastErr = new Error('Could not read the account name from X.'); continue; }
      let displayName = null; let xUserId = null;
      try {
        const r = await axios.get('https://api.x.com/1.1/account/verify_credentials.json', { headers: headers(acc), timeout: 20000 });
        displayName = r.data && r.data.name; xUserId = r.data && r.data.id_str;
      } catch (_) { /* optional */ }
      return { username, displayName, xUserId };
    } catch (err) {
      if (!err.response) throw err;
      const status = err.response.status;
      if (status === 404) { lastErr = xError(err); continue; }
      throw xError(err);
    }
  }
  throw new Error(lastErr && lastErr.message ? `X did not answer on any known endpoint (${lastErr.message}). Please try again later.` : 'X did not answer. Please try again later.');
}

// ---- GraphQL queryId (changes when X ships a new web build) ---------------------
let cachedQueryId = null; let cachedAt = 0;
async function discoverQueryId(acc) {
  if (process.env.X_CREATETWEET_QUERY_ID) return process.env.X_CREATETWEET_QUERY_ID;
  if (cachedQueryId && Date.now() - cachedAt < 6 * 3600 * 1000) return cachedQueryId;
  try {
    const home = await axios.get('https://x.com/', { headers: { 'user-agent': UA, cookie: `auth_token=${acc.auth_token}; ct0=${acc.ct0}` }, timeout: 20000 });
    const scripts = [...String(home.data).matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"']*?\/main\.[a-z0-9]+\.js/g)].map((m) => m[0]);
    for (const url of scripts) {
      const js = (await axios.get(url, { timeout: 30000 })).data;
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
  const init = await axios.post(base, null, { headers: h, timeout: 30000,
    params: { command: 'INIT', total_bytes: buf.length, media_type: mime, media_category: 'tweet_image' } });
  const mediaId = init.data.media_id_string;
  const form = new FormData();
  form.append('media', buf, { filename: 'blob', contentType: 'application/octet-stream' });
  await axios.post(base, form, { headers: { ...h, ...form.getHeaders() }, timeout: 120000, maxBodyLength: Infinity,
    params: { command: 'APPEND', media_id: mediaId, segment_index: 0 } });
  await axios.post(base, null, { headers: h, timeout: 30000, params: { command: 'FINALIZE', media_id: mediaId } });
  return mediaId;
}

// Keep the tweet inside 280 chars: the link always counts 23, the text is trimmed.
function fitTweet(text, url) {
  const budget = TWEET_LIMIT - (url ? URL_WEIGHT + 2 : 0);
  let t = String(text || '').trim();
  if (t.length > budget) t = t.slice(0, budget - 1).replace(/\s+\S*$/, '') + '…';
  return url ? `${t}\n\n${url}` : t;
}

// ---- post -------------------------------------------------------------------------
async function postTweet(account, { text, url, imagePaths = [] }) {
  const acc = { ...account };
  try {
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
      },
      features: FEATURES, queryId,
    };
    const { data } = await axios.post(`https://x.com/i/api/graphql/${queryId}/CreateTweet`, body, {
      headers: headers(acc, { 'content-type': 'application/json' }), timeout: 30000,
    });
    if (data && data.errors && data.errors.length) {
      const e = new Error(String(data.errors[0].message || 'X refused the post').slice(0, 300));
      e.expired = data.errors.some((x) => x.code === 32 || x.code === 89);
      throw e;
    }
    const r = data && data.data && data.data.create_tweet && data.data.create_tweet.tweet_results && data.data.create_tweet.tweet_results.result;
    const id = r && (r.rest_id || (r.tweet && r.tweet.rest_id));
    if (!id) throw new Error('X did not confirm the post.');
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

module.exports = { parseCookies, verify, postTweet, fitTweet, TWEET_LIMIT };
