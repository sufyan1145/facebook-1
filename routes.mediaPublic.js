/**
 * Serves a local file at a random, short-lived, UNAUTHENTICATED URL -
 * Instagram's Graph API (services.instagramService.js) needs to fetch the
 * video itself from a public URL rather than accepting a direct byte
 * upload like Facebook does, so this exists purely to hand it one safely:
 *   - the token is a random 48-char hex string (effectively unguessable)
 *   - each registration expires on its own (default 15 min - comfortably
 *     longer than Instagram's own container-processing time) even if
 *     nothing ever explicitly unregisters it
 *   - only files explicitly registered via registerTempPublicFile are
 *     servable - this can't be used to browse/read arbitrary server files
 *
 * No other part of the app should use this for anything long-lived; it's a
 * single-purpose bridge for handing one temp video file to Instagram.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const env = require('./config.env');
const logger = require('./utils.logger');

const router = express.Router();
const registry = new Map(); // token -> { filePath, expiresAt }

function registerTempPublicFile(filePath, ttlMs = 15 * 60 * 1000) {
  const token = crypto.randomBytes(24).toString('hex');
  registry.set(token, { filePath, expiresAt: Date.now() + ttlMs });
  return token;
}

function unregisterTempPublicFile(token) {
  const e = registry.get(token);
  registry.delete(token);
  if (e && e.owned) { try { fs.unlinkSync(e.filePath); } catch (_) { /* ignore */ } }
}

// ---- files pushed by the worker process (it has no web server of its own) ----
// The worker PUTs the video here (signed with the shared TOKEN_ENCRYPTION_KEY), the web app keeps it for a short
// while and serves it at /media-temp/<token>.mp4 so Instagram can fetch it.
const UPLOAD_DIR = path.join(os.tmpdir(), 'media-temp-uploads');
const MAX_BYTES = 600 * 1024 * 1024;
const TOKEN_RE = /^[a-f0-9]{48}$/;
const sigFor = (token) => crypto.createHmac('sha256', String(env.tokenEncryptionKey || 'k')).update(`media:${token}`).digest('hex');
function sigOk(token, given) {
  const a = Buffer.from(sigFor(token)); const b = Buffer.from(String(given || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Catches anything that expired without being explicitly unregistered (e.g.
// a crashed job) so the registry doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of registry) {
    if (entry.expiresAt < now) unregisterTempPublicFile(token);
  }
}, 60 * 1000).unref();

router.put('/upload/:token', (req, res) => {
  const { token } = req.params;
  if (!TOKEN_RE.test(token) || !sigOk(token, req.headers['x-media-sig'])) return res.status(403).send('Forbidden');
  const len = Number(req.headers['content-length']) || 0;
  if (len > MAX_BYTES) return res.status(413).send('Too large');
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const filePath = path.join(UPLOAD_DIR, `${token}.mp4`);
  const out = fs.createWriteStream(filePath);
  let size = 0; let failed = false;
  const fail = (code, msg) => { if (failed) return; failed = true; out.destroy(); try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ } if (!res.headersSent) res.status(code).send(msg); };
  req.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(); fail(413, 'Too large'); } });
  req.on('error', () => fail(400, 'Upload failed'));
  out.on('error', () => fail(500, 'Could not store the file'));
  out.on('finish', () => {
    if (failed) return;
    registry.set(token, { filePath, expiresAt: Date.now() + 30 * 60 * 1000, owned: true });
    res.json({ ok: true, bytes: size });
  });
  req.pipe(out);
});

router.delete('/:token', (req, res) => {
  const token = String(req.params.token).replace(/\.mp4$/, '');
  if (!TOKEN_RE.test(token) || !sigOk(token, req.headers['x-media-sig'])) return res.status(403).send('Forbidden');
  unregisterTempPublicFile(token);
  res.json({ ok: true });
});

router.get('/:token', (req, res) => {
  const entry = registry.get(String(req.params.token).replace(/\.mp4$/, ''));
  if (!entry || entry.expiresAt < Date.now()) {
    return res.status(404).send('Not found or expired');
  }
  if (!fs.existsSync(entry.filePath)) {
    logger.error(`[media-temp] registered file is missing on disk: ${entry.filePath}`);
    return res.status(404).send('File no longer available');
  }
  res.sendFile(path.resolve(entry.filePath));
});

module.exports = { router, registerTempPublicFile, unregisterTempPublicFile, sigFor };
