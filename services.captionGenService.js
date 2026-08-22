/**
 * Generates a fresh caption for Text+Image Post "topic" mode scheduling.
 * Standalone module (like services.imageGenService.js) so it can't affect the
 * Content Pipeline's own writeScript usage.
 */
const geminiService = require('./services.geminiService');
const logger = require('./utils.logger');

// Tries Gemini with zero retries (instant fallback, no waiting); if it fails
// for any reason, falls back to just using the topic text itself as the
// caption rather than failing the whole scheduled post.
async function generateCaption(topic) {
  try {
    return await geminiService.generateCaption(topic, { retries: 0 });
  } catch (err) {
    logger.warn(`[captionGenService] Caption generation failed (${err.message}) - falling back to using the topic text directly`);
    return topic;
  }
}

module.exports = { generateCaption };
