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
const crypto = require('crypto');
const logger = require('./utils.logger');

const router = express.Router();
const registry = new Map(); // token -> { filePath, expiresAt }

function registerTempPublicFile(filePath, ttlMs = 15 * 60 * 1000) {
  const token = crypto.randomBytes(24).toString('hex');
  registry.set(token, { filePath, expiresAt: Date.now() + ttlMs });
  return token;
}

function unregisterTempPublicFile(token) {
  registry.delete(token);
}

// Catches anything that expired without being explicitly unregistered (e.g.
// a crashed job) so the registry doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of registry) {
    if (entry.expiresAt < now) registry.delete(token);
  }
}, 60 * 1000).unref();

router.get('/:token', (req, res) => {
  const entry = registry.get(req.params.token);
  if (!entry || entry.expiresAt < Date.now()) {
    return res.status(404).send('Not found or expired');
  }
  if (!fs.existsSync(entry.filePath)) {
    logger.error(`[media-temp] registered file is missing on disk: ${entry.filePath}`);
    return res.status(404).send('File no longer available');
  }
  res.sendFile(path.resolve(entry.filePath));
});

module.exports = { router, registerTempPublicFile, unregisterTempPublicFile };
