/**
 * Generates a matching (caption + imagePrompt) pair for Text+Image Post
 * "topic" mode scheduling. Standalone module (like services.imageGenService.js)
 * so it can't affect the Content Pipeline's own writeScript usage.
 */
const geminiService = require('./services.geminiService');
const logger = require('./utils.logger');

// Tries Gemini with 2 retries (short backoff) since transient 503s ("model
// overloaded") are common and usually resolve within seconds - unlike image
// generation, there's no equivalent second provider to fall back to for text,
// so it's worth waiting briefly before giving up. If it still fails after
// retries, falls back to using the raw topic text as both the caption and
// the image prompt, so the scheduled post still goes out rather than failing
// entirely. Returns fallbackReason (non-null only when the fallback was used)
// so the caller can surface it in Activity Logs.
// avoidList: recent captions from this same schedule, passed through so the
// AI knows what's already been covered and picks something different.
async function generatePostContent(topic, avoidList) {
  try {
    const result = await geminiService.generatePostContent(topic, { retries: 2, avoidList });
    return { ...result, fallbackReason: null };
  } catch (err) {
    logger.warn(`[captionGenService] Structured content generation failed after retries (${err.message}) - falling back to using the topic text directly for both caption and image`);
    return { caption: topic, imagePrompt: topic, fallbackReason: err.message };
  }
}

module.exports = { generatePostContent };
