/**
 * Short-lived store for "preview before posting" AI-generated images.
 * Backed by Redis (the same connection BullMQ already uses) rather than local
 * disk, because the web service (where the preview is generated and viewed)
 * and the worker service (where the actual Facebook post happens) are two
 * separate Railway processes that do not share a filesystem - only Redis and
 * Postgres are common infrastructure between them.
 */
const connection = require('./queue.connection');
const crypto = require('crypto');

const TTL_SECONDS = 15 * 60; // previews expire after 15 minutes if never posted

function keyFor(previewId) {
  return `text-image-preview:${previewId}`;
}

// Stores an image buffer, returns a random previewId to reference it by.
async function savePreview(userId, imageBuffer) {
  const previewId = crypto.randomUUID();
  const payload = JSON.stringify({ userId, data: imageBuffer.toString('base64') });
  await connection.set(keyFor(previewId), payload, 'EX', TTL_SECONDS);
  return previewId;
}

// Returns { userId, buffer } or null if missing/expired.
async function getPreview(previewId) {
  const raw = await connection.get(keyFor(previewId));
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  return { userId: parsed.userId, buffer: Buffer.from(parsed.data, 'base64') };
}

async function deletePreview(previewId) {
  await connection.del(keyFor(previewId));
}

module.exports = { savePreview, getPreview, deletePreview };
