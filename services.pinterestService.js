/**
 * Pinterest - official API v5 with OAuth (no cookies). Used to turn a published article into a Pin:
 * 2:3 picture + SEO title/description + the article link.
 * Trial access: Pins are created but only the owner can see them until Pinterest approves "Standard" access.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const env = require('./config.env');
const PinterestAccount = require('./models.PinterestAccount');
const logger = require('./utils.logger');

const API = 'https://api.pinterest.com/v5';
const SCOPES = ['boards:read', 'boards:write', 'pins:read', 'pins:write', 'user_accounts:read'];

const appId = () => (process.env.PINTEREST_APP_ID || '').trim();
const appSecret = () => (process.env.PINTEREST_APP_SECRET || '').trim();
const redirectUri = () => (process.env.PINTEREST_REDIRECT_URI || `${String(env.appUrl).replace(/\/+$/, '')}/api/pinterest/callback`).trim();
const configured = () => !!(appId() && appSecret());

function pinterestError(err) {
  const d = err.response && err.response.data;
  const msg = (d && (d.message || d.error_description || d.error)) || err.message;
  const e = new Error(String(msg));
  e.status = err.response && err.response.status;
  e.pinCode = d && d.code;
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
  if (!configured()) throw new Error('Pinterest is not set up: add PINTEREST_APP_ID and PINTEREST_APP_SECRET to the server settings.');
  const q = new URLSearchParams({ client_id: appId(), redirect_uri: redirectUri(), response_type: 'code', scope: SCOPES.join(','), state: makeState(userId) });
  return `https://www.pinterest.com/oauth/?${q.toString()}`;
}

async function tokenCall(form) {
  try {
    const { data } = await axios.post(`${API}/oauth/token`, new URLSearchParams(form).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${appId()}:${appSecret()}`).toString('base64')}` },
      timeout: 30000,
    });
    const now = Date.now();
    return {
      accessToken: data.access_token, refreshToken: data.refresh_token || null,
      expiresAt: data.expires_in ? new Date(now + data.expires_in * 1000) : null,
      refreshExpiresAt: data.refresh_token_expires_in ? new Date(now + data.refresh_token_expires_in * 1000) : null,
    };
  } catch (err) { throw pinterestError(err); }
}

const exchangeCode = (code) => tokenCall({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), continuous_refresh: 'true' });

// A fresh access token for an account (refreshes it when it is about to expire).
async function accessTokenFor(acc) {
  if (acc.expires_at && new Date(acc.expires_at).getTime() - Date.now() > 10 * 60 * 1000) return acc.access_token;
  if (!acc.refresh_token) return acc.access_token;
  try {
    const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: acc.refresh_token, scope: SCOPES.join(',') });
    await PinterestAccount.setTokens(acc.id, t);
    return t.accessToken;
  } catch (err) {
    await PinterestAccount.markExpired(acc.id, `Login expired: ${err.message}`);
    throw new Error('The Pinterest login expired. Open Social Accounts and add this Pinterest account again.');
  }
}

async function api(acc, method, url, data, params) {
  const token = await accessTokenFor(acc);
  try {
    const r = await axios({ method, url: `${API}${url}`, data, params, headers: { Authorization: `Bearer ${token}` }, timeout: 60000, maxBodyLength: Infinity });
    return r.data;
  } catch (err) {
    const e = pinterestError(err);
    if (e.status === 401) await PinterestAccount.markExpired(acc.id, e.message);
    throw e;
  }
}

const userAccount = (tokenOnly) => api({ id: null, access_token: tokenOnly, expires_at: new Date(Date.now() + 3600e3) }, 'get', '/user_account');

async function listBoards(acc) {
  const out = []; let bookmark;
  for (let i = 0; i < 5; i++) {
    const r = await api(acc, 'get', '/boards', undefined, { page_size: 100, ...(bookmark ? { bookmark } : {}) });
    for (const b of r.items || []) out.push({ id: b.id, name: b.name, privacy: b.privacy });
    bookmark = r.bookmark; if (!bookmark) break;
  }
  return out;
}

// ---- Pin picture: 1000x1500 (2:3), picture fills it, title on a dark band at the bottom (Latin text only) ----
function wrapTitle(t, width = 20, maxLines = 4) {
  const words = String(t || '').replace(/\s+/g, ' ').trim().split(' '); const lines = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > width && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines).join('\n');
}
const isLatin = (t) => !/[^\u0000-ɏ -⁯₠-⃏\s]/.test(String(t || ''));

function makePinImage(srcPath, title, outPath) {
  const dir = path.dirname(outPath);
  let vf = 'scale=1000:1500:force_original_aspect_ratio=increase,crop=1000:1500';
  let textFile = null;
  if (title && isLatin(title) && process.env.PINTEREST_TITLE_OVERLAY !== 'false') {
    textFile = path.join(dir, `pin_${crypto.randomBytes(5).toString('hex')}.txt`);
    fs.writeFileSync(textFile, wrapTitle(title));
    vf += `,drawtext=textfile='${textFile}':font='DejaVu Sans Bold':fontsize=64:fontcolor=white:line_spacing=14:box=1:boxcolor=black@0.62:boxborderw=34:x=(w-text_w)/2:y=h-text_h-110`;
  }
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-loglevel', 'error', '-i', srcPath, '-vf', vf, '-frames:v', '1', '-q:v', '3', outPath], { timeout: 60000 }, (err, _o, stderr) => {
      if (textFile) { try { fs.unlinkSync(textFile); } catch (_) { /* ignore */ } }
      if (err) return reject(new Error(`pin image failed: ${String(stderr || err.message).slice(0, 200)}`));
      resolve(outPath);
    });
  });
}

async function createPin(acc, { imagePath, title, description, altText, link, overlayTitle }) {
  if (!acc.board_id) throw new Error('No board chosen for this Pinterest account (Social Accounts -> choose a board).');
  const tmp = path.resolve(env.upload.tempDir || './uploads');
  fs.mkdirSync(tmp, { recursive: true });
  const out = path.join(tmp, `pin_${crypto.randomBytes(6).toString('hex')}.jpg`);
  try {
    await makePinImage(imagePath, overlayTitle || title, out);
    const body = {
      board_id: acc.board_id,
      title: String(title || '').slice(0, 100),
      description: String(description || '').slice(0, 800),
      link,
      alt_text: String(altText || title || '').slice(0, 500),
      media_source: { source_type: 'image_base64', content_type: 'image/jpeg', data: fs.readFileSync(out).toString('base64') },
    };
    const r = await api(acc, 'post', '/pins', body);
    await PinterestAccount.markUsed(acc.id);
    return { id: r.id, url: `https://www.pinterest.com/pin/${r.id}/` };
  } finally { try { fs.unlinkSync(out); } catch (_) { /* ignore */ } }
}

module.exports = { configured, authUrl, readState, exchangeCode, userAccount, listBoards, createPin, makePinImage, redirectUri, wrapTitle, isLatin };
