/**
 * On-demand single-image generation for the Text + Image Post feature.
 * Deliberately locked to Gemini's free-tier "Nano Banana" model
 * (gemini-2.5-flash-image) regardless of whatever IMAGE_PROVIDER the Content
 * Pipeline is configured with - this feature should never spend KIE/Vertex
 * credits, only the free Gemini API key (the "d2f poster" project, billing
 * disabled). Standalone module: does not import or affect
 * jobs.contentPipelineWorker.js in any way.
 */
const geminiService = require('./services.geminiService');

// Generates one still image from a text prompt, saved to destPath, using
// Gemini's free Nano Banana image model.
async function generateImage(prompt, destPath) {
  await geminiService.generateImage(prompt, destPath);
}

module.exports = { generateImage };
