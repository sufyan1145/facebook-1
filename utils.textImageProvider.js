/**
 * Which AI provider the Text + Image Post section uses (images AND captions).
 *
 *   TEXT_IMAGE_PROVIDER=vertex  -> always Vertex AI first
 *   TEXT_IMAGE_PROVIDER=gemini  -> always the free-tier Gemini API key first
 *   TEXT_IMAGE_PROVIDER=auto    -> (default) Vertex AI when VERTEX_PROJECT_ID and
 *                                  VERTEX_CREDENTIALS_BASE64 are set, else Gemini
 *
 * Standalone: does not read IMAGE_PROVIDER / SCRIPT_PROVIDER, so it cannot
 * change how the Content Pipeline behaves.
 */
const env = require('./config.env');

function vertexConfigured() {
  return !!(env.vertexAi && env.vertexAi.projectId && env.vertexAi.credentialsBase64);
}

function resolveProvider() {
  const p = (process.env.TEXT_IMAGE_PROVIDER || 'auto').trim().toLowerCase();
  if (p === 'vertex' || p === 'gemini') return p;
  return vertexConfigured() ? 'vertex' : 'gemini';
}

module.exports = { resolveProvider, vertexConfigured };
