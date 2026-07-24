const axios = require('axios');
const fs = require('fs');
const logger = require('./utils.logger');

// Pollinations.ai: free, no API key, no signup image generation.
// Anonymous requests are soft-rate-limited (~1 request/15s), which is fine here
// since we only need 1 image per scene, minutes apart.
async function generateImage(prompt, destPath, width = 1080, height = 1920) {
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`;
  logger.info(`[pollinations] requesting image for prompt: ${prompt.slice(0, 80)}...`);

  const resp = await axios.get(url, {
    params: { width, height, nologo: 'true', model: 'flux', enhance: 'true' },
    responseType: 'arraybuffer',
    timeout: 60000,
  });

  fs.writeFileSync(destPath, resp.data);
  logger.info(`[pollinations] saved image to ${destPath}`);
  return destPath;
}

module.exports = { generateImage };
