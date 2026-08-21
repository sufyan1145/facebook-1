/**
 * On-demand single-image generation for the Text + Image Post feature.
 * Primary: Gemini's free-tier "Nano Banana" model (gemini-2.5-flash-image) - best
 * quality/realism, native 4K, but capped at Google's free-tier daily quota.
 * Fallback: Pollinations.ai (no API key, no quota) - used automatically whenever
 * Gemini fails for any reason (quota exceeded, auth issue, timeout, etc.), so a
 * post never gets stuck just because the daily Gemini quota ran out.
 * Standalone module: does not import or affect jobs.contentPipelineWorker.js in
 * any way, regardless of what IMAGE_PROVIDER the pipeline is configured with.
 */
const geminiService = require('./services.geminiService');
const pollinationsService = require('./services.pollinationsService');
const logger = require('./utils.logger');

// Tries Gemini (Nano Banana) first with ZERO retries - a single quota-exceeded
// (429) or any other failure falls straight through to Pollinations.ai instantly,
// with no retry/backoff delay. This trades "wait a few minutes for Gemini to
// possibly recover" for "never keep the post waiting."
async function generateImage(prompt, destPath, { width = 1080, height = 1080 } = {}) {
  try {
    await geminiService.generateImage(prompt, destPath, { retries: 0 });
    return;
  } catch (err) {
    logger.warn(`[imageGenService] Gemini image generation failed (${err.message}) - falling back to Pollinations.ai instantly`);
  }

  await pollinationsService.generateImage(prompt, destPath, width, height);
}

module.exports = { generateImage };
