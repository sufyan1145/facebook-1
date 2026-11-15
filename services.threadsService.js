/**
 * Threads (Meta) - official Threads API with OAuth (no cookies).
 * Posts: text or one picture. The picture must be reachable on a public URL, so it is briefly copied to /web-images.
 * Link options: link in the post text, or in a reply to the post (reaches more people).
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const env = require('./config.env');
const ThreadsAccount = require('./models.ThreadsAccount');
const logger = require('./utils.logger');

const GRAPH = 'https://graph.threads.net';
const SCOPES = ['threads_basic', 'threads_content_publish'];
const MAX_TEXT = 500;

const appId = () => (process.env.THREADS_APP_ID || '').trim();
const appSecret = () => (process.env.THREADS_APP_SECRET || '').trim();
const redirectUri = () => (process.env.THREADS_REDIRECT_URI || `${String(env.appUrl).replace(/\/+$/, '')}/api/threads/callback`).trim();
const configured = () => !!(appId() && appSecret());

function threadsError(err) {
  const d = err.response && err.response.data;
  const m = d && (d.error && (d.error.error_user_msg || d.error.message) || d.error_message || d.message);
  const e = new Error(String(m || err.message));
  e.status = err.response && err.response.status;
  e.threadsCode = d && d.error && d.error.code;
  return e;
}

// ---- signed OAuth "state" (carries the user id, valid 15 minutes) ----
const sign = (s) => crypto.createHmac('sha256', String(env.tokenEncryptionKey || 'k')).update(s).digest('hex').slice(0, 32);
function makeState(userId) { const p = `${userId}.${Date.now()}`; return `${p}.${sign(p)}`; }
function readState(state) {
  const parts = String(state || '').split('.');
  if (parts.length !== 3) return null;
  const p = `${parts[0]}.${parts[1]}`;
  if (sign(p) !== parts[2] || Date.now() - Number(parts[1]) > 15 * 60 * 1000) return null;
  return parts[0];
}

function authUrl(userId) {
  if (!configured()) throw new Error('Threads is not set up: add THREADS_APP_ID and THREADS_APP_SECRET to the server settings.');
  const q = new URLSearchParams({ client_id: appId(), redirect_uri: redirectUri(), scope: SCOPES.join(','), response_type: 'code', state: makeState(userId) });
  return `https://threads.net/oauth/authorize?${q.toString()}`;
}

// code -> short-lived token -> long-lived token (60 days)
async function exchangeCode(code) {
  try {
    const short = await axios.post(`${GRAPH}/oauth/access_token`, new URLSearchParams({
      client_id: appId(), client_secret: appSecret(), grant_type: 'authorization_code', redirect_uri: redirectUri(), code: String(code || '').replace(/#_$/, ''),
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
    const long = await axios.get(`${GRAPH}/access_token`, {
      params: { grant_type: 'th_exchange_token', client_secret: appSecret(), access_token: short.data.access_token }, timeout: 30000,
    });
    const expiresIn = Number(long.data.expires_in) || 60 * 24 * 3600;
    return { accessToken: long.data.access_token, threadsUserId: String(short.data.user_id), expiresAt: new Date(Date.now() + expiresIn * 1000) };
  } catch (err) { throw threadsError(err); }
}

async function profile(accessToken) {
  try {
    const { data } = await axios.get(`${GRAPH}/v1.0/me`, { params: { fields: 'id,username', access_token: accessToken }, timeout: 30000 });
    return data;
  } catch (err) { throw threadsError(err); }
}

// A valid token for the account; refreshes it when it expires within 7 days.
async function tokenFor(acc) {
  const left = acc.expires_at ? new Date(acc.expires_at).getTime() - Date.now() : Infinity;
  if (left > 7 * 24 * 3600 * 1000) return acc.access_token;
  try {
    const { data } = await axios.get(`${GRAPH}/refresh_access_token`, { params: { grant_type: 'th_refresh_token', access_token: acc.access_token }, timeout: 30000 });
    const exp = new Date(Date.now() + (Number(data.expires_in) || 60 * 24 * 3600) * 1000);
    await ThreadsAccount.setToken(acc.id, data.access_token, exp);
    return data.access_token;
  } catch (err) {
    if (left > 0) return acc.access_token; // refresh failed but the token still works
    await ThreadsAccount.markExpired(acc.id, `Login expired: ${threadsError(err).message}`);
    throw new Error('The Threads login expired. Open Social Accounts and add this Threads account again.');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, url, params) {
  try {
    const r = await axios({ method, url: `${GRAPH}/v1.0${url}`, params: method === 'get' ? params : undefined, data: method === 'post' ? new URLSearchParams(params).toString() : undefined,
      headers: method === 'post' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : undefined, timeout: 60000 });
    return r.data;
  } catch (err) { throw threadsError(err); }
}

// Create a container, wait until Threads has processed it, publish it. Returns the new post id.
async function publish(acc, token, fields) {
  const container = await call('post', `/${acc.threads_user_id}/threads`, { ...fields, access_token: token });
  for (let i = 0; i < 20; i++) { // pictures need a few seconds
    await sleep(i === 0 ? 3000 : 4000);
    const st = await call('get', `/${container.id}`, { fields: 'status,error_message', access_token: token });
    if (st.status === 'FINISHED') break;
    if (st.status === 'ERROR' || st.status === 'EXPIRED') throw new Error(`Threads could not process the post: ${st.error_message || st.status}`);
  }
  const pub = await call('post', `/${acc.threads_user_id}/threads_publish`, { creation_id: container.id, access_token: token });
  return pub.id;
}

// ---- picture on a public URL (the web app serves /web-images) ----
async function hostImage(srcPath) {
  const dir = path.resolve(env.upload.websiteImagesDir);
  fs.mkdirSync(dir, { recursive: true });
  const name = `threads_${crypto.randomBytes(8).toString('hex')}.jpg`;
  const out = path.join(dir, name);
  await new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', srcPath, '-vf', "scale='min(1440,iw)':-2", '-frames:v', '1', '-q:v', '3', out],
      { timeout: 60000 }, (err, _o, stderr) => (err ? reject(new Error(String(stderr || err.message).slice(0, 200))) : resolve()));
  });
  const url = `${String(env.appUrl).replace(/\/+$/, '')}/web-images/${name}`;
  try { await axios.head(url, { timeout: 15000 }); }
  catch (_) { try { fs.unlinkSync(out); } catch (e) { /* ignore */ } return null; } // the web server cannot see this file (separate worker) -> text-only
  return { url, cleanup: () => { try { fs.unlinkSync(out); } catch (_) { /* ignore */ } } };
}

const clip = (t, n = MAX_TEXT) => { const s = String(t || '').trim(); return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`; };

/**
 * post an article: text (+ picture). linkInReply=true -> the link is a reply to the post, otherwise it is in the post.
 */
async function postArticle(acc, { text, cta, url, imagePath, linkInReply }) {
  const token = await tokenFor(acc);
  let img = null; let imageNote = '';
  if (imagePath) {
    try { img = await hostImage(imagePath); if (!img) imageNote = ' (no picture: the web server could not serve it)'; }
    catch (err) { logger.warn(`[threads] picture skipped: ${err.message}`); imageNote = ' (no picture)'; }
  }
  try {
    const body = linkInReply ? clip(text) : clip(text, MAX_TEXT - url.length - 2);
    const fields = img ? { media_type: 'IMAGE', image_url: img.url, text: linkInReply ? body : `${body}\n\n${url}` }
      : { media_type: 'TEXT', text: linkInReply ? body : body, ...(linkInReply ? {} : { link_attachment: url }) };
    const id = await publish(acc, token, fields);
    await ThreadsAccount.markUsed(acc.id);
    let note = imageNote;
    if (linkInReply) {
      try { await publish(acc, token, { media_type: 'TEXT', text: clip(`${cta || ''}\n${url}`.trim()), reply_to_id: id }); note = ` (link in reply)${imageNote}`; }
      catch (err) { logger.warn(`[threads] link reply failed: ${err.message}`); note = ` (posted, but the link reply failed: ${String(err.message).slice(0, 120)} - link: ${url})`; }
    }
    return { id, note };
  } catch (err) {
    if (err.status === 401 || err.threadsCode === 190) await ThreadsAccount.markExpired(acc.id, err.message);
    throw err;
  } finally { if (img) img.cleanup(); }
}

module.exports = { configured, authUrl, readState, exchangeCode, profile, postArticle, redirectUri };
