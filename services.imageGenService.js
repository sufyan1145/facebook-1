/**
 * On-demand single-image generation for the Text + Image Post feature.
 *
 * Order of providers (see utils.textImageProvider.js):
 *   1. Vertex AI (Nano Banana via your Google Cloud billing account) - used first
 *      whenever Vertex is configured (or TEXT_IMAGE_PROVIDER=vertex).
 *   2. Gemini free-tier API key (gemini-2.5-flash-image), zero retries.
 *   3. Pollinations.ai (no key, no quota) - last resort, so a post is never
 *      stuck just because a provider is down or out of quota.
 * Standalone module: does not touch jobs.contentPipelineWorker.js or its
 * IMAGE_PROVIDER setting.
 */
const geminiService = require('./services.geminiService');
const pollinationsService = require('./services.pollinationsService');
const vertexAiService = require('./services.vertexAiService');
const { resolveProvider } = require('./utils.textImageProvider');
const env = require('./config.env');
const logger = require('./utils.logger');

async function generateImage(prompt, destPath, { width = 1080, height = 1080 } = {}) {
  const provider = resolveProvider();

  if (provider === 'vertex') {
    try {
      // One short retry only: Vertex has no free-tier daily cap, so a failure
      // is usually transient or a safety-filter block - don't make the person wait minutes.
      await vertexAiService.generateImage(prompt, destPath, { retries: 1 });
      logger.info('[imageGenService] image generated with Vertex AI');
      return;
    } catch (err) {
      logger.warn(`[imageGenService] Vertex image generation failed (${err.message}) - trying Gemini free tier next`);
    }
  }

  if (env.googleAi && env.googleAi.geminiApiKey) {
    try {
      await geminiService.generateImage(prompt, destPath, { retries: 0 });
      logger.info('[imageGenService] image generated with Gemini API key');
      return;
    } catch (err) {
      logger.warn(`[imageGenService] Gemini image generation failed (${err.message}) - falling back to Pollinations.ai instantly`);
    }
  }

  await pollinationsService.generateImage(prompt, destPath, width, height);
  logger.info('[imageGenService] image generated with Pollinations.ai (last-resort fallback)');
}

module.exports = { generateImage };
