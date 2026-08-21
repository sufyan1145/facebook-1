/**
 * On-demand single-image generation for the Text + Image Post feature.
 * Deliberately standalone: mirrors the provider-selection logic already used by
 * jobs.contentPipelineWorker.js, but as its own copy, so nothing here can change
 * how the existing Content Pipeline / Video Generator behave.
 */
const env = require('./config.env');
const geminiService = require('./services.geminiService');
const vertexAiService = require('./services.vertexAiService');
const pollinationsService = require('./services.pollinationsService');
const kieVideoService = require('./services.kieVideoService');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Generates one still image from a text prompt, saved to destPath.
// Uses the same IMAGE_PROVIDER env setting as the Content Pipeline (kie/gemini/vertex/pollinations)
// purely so behavior is consistent across the app - this function does not write to or
// depend on any Content Pipeline state.
async function generateImage(prompt, destPath, { width = 1080, height = 1080, aspectRatio = '1:1' } = {}) {
  const provider = env.contentPipeline.imageProvider;

  if (provider === 'gemini') {
    await geminiService.generateImage(prompt, destPath);
    return;
  }
  if (provider === 'vertex') {
    await vertexAiService.generateImage(prompt, destPath);
    return;
  }
  if (provider === 'pollinations') {
    await pollinationsService.generateImage(prompt, destPath, width, height);
    return;
  }

  // Default: kie.ai image task (polled until ready)
  const taskId = await kieVideoService.createImageTask({ prompt, aspectRatio });
  const maxAttempts = 30; // images are fast, ~5 min ceiling
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(5000);
    const status = await kieVideoService.getTaskStatus(taskId);
    const state = status.state || status.status;
    if (state === 'success') {
      const url = kieVideoService.extractResultUrl(status);
      if (!url) throw new Error('Image generated but no result URL was returned');
      await kieVideoService.downloadResult(url, destPath);
      return;
    }
    if (state === 'fail') {
      throw new Error(status.failMsg || status.failReason || 'Image generation failed');
    }
  }
  throw new Error('Image generation timed out');
}

module.exports = { generateImage };
