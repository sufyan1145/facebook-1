/**
 * Generates a matching (caption + imagePrompt) pair for Text+Image Post
 * "topic" mode scheduling. Standalone module (like services.imageGenService.js)
 * so it can't affect the Content Pipeline's own writeScript usage.
 */
const geminiService = require('./services.geminiService');
const logger = require('./utils.logger');

// Tries Gemini with zero retries (instant fallback, no waiting); if it fails
// or returns unparseable output for any reason, falls back to using the raw
// topic text as both the caption and the image prompt, so the scheduled post
// still goes out rather than failing entirely.
async function generatePostContent(topic) {
  try {
    return await geminiService.generatePostContent(topic, { retries: 0 });
  } catch (err) {
    logger.warn(`[captionGenService] Structured content generation failed (${err.message}) - falling back to using the topic text directly for both caption and image`);
    return { caption: topic, imagePrompt: topic };
  }
}

module.exports = { generatePostContent };
