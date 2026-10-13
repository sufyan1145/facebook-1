/**
 * Generates a matching (caption + imagePrompt) pair for Text+Image Post
 * "topic" mode scheduling. Standalone module (like services.imageGenService.js)
 * so it can't affect the Content Pipeline's own writeScript usage.
 */
const geminiService = require('./services.geminiService');
const vertexAiService = require('./services.vertexAiService');
const { resolveProvider } = require('./utils.textImageProvider');
const env = require('./config.env');
const logger = require('./utils.logger');

// Provider is picked by utils.textImageProvider.js (Vertex when configured,
// or TEXT_IMAGE_PROVIDER=vertex/gemini). Primary provider gets 2 retries
// (transient 503s are common and usually clear in seconds). If Vertex still
// fails, the free Gemini key is tried before giving up; if everything fails,
// falls back to using the raw topic text as both the caption and the image
// prompt, so the scheduled post still goes out. fallbackReason is non-null
// only when that last fallback was used (surfaced in Activity Logs).
// avoidList: recent captions from this same schedule, so the AI picks
// something different.
async function generatePostContent(topic, avoidList) {
  const provider = resolveProvider();
  const tryGemini = () => geminiService.generatePostContent(topic, { retries: 2, avoidList });

  try {
    if (provider === 'vertex') {
      try {
        const result = await vertexAiService.generatePostContent(topic, { avoidList });
        return { ...result, fallbackReason: null };
      } catch (vErr) {
        if (!(env.googleAi && env.googleAi.geminiApiKey)) throw vErr;
        logger.warn(`[captionGenService] Vertex content generation failed (${vErr.message}) - trying Gemini free tier`);
      }
    }
    const result = await tryGemini();
    return { ...result, fallbackReason: null };
  } catch (err) {
    logger.warn(`[captionGenService] Structured content generation failed after retries (${err.message}) - falling back to using the topic text directly for both caption and image`);
    return { caption: topic, imagePrompt: topic, fallbackReason: err.message };
  }
}

module.exports = { generatePostContent };
