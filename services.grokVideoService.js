const axios = require('axios');
const fs = require('fs');
const env = require('./config.env');
const logger = require('./utils.logger');

const client = axios.create({
  baseURL: 'https://api.x.ai',
  headers: { Authorization: `Bearer ${env.grok.apiKey}`, 'Content-Type': 'application/json' },
});

// Kicks off a Grok Imagine text-to-video generation job. Max supported duration
// is 15 seconds - callers should cap/trim to that themselves if a scene runs longer.
async function createVideoTask({ prompt, duration, aspectRatio }) {
  const requestBody = {
    model: env.grok.videoModel,
    prompt,
    duration: Math.min(Math.round(duration), 15),
    aspect_ratio: aspectRatio || '9:16',
  };
  logger.info(`[grok] video generation request: ${JSON.stringify(requestBody)}`);
  const resp = await client.post('/v1/videos/generations', requestBody);
  logger.info(`[grok] video generation response: ${JSON.stringify(resp.data)}`);

  const requestId = resp.data.request_id;
  if (!requestId) throw new Error(`Grok did not return a request_id: ${JSON.stringify(resp.data)}`);
  return requestId;
}

async function getTaskStatus(requestId) {
  const resp = await client.get(`/v1/videos/${requestId}`);
  return resp.data;
}

function extractResultUrl(status) {
  return status.video?.url || null;
}

async function downloadResult(url, destPath) {
  const writer = fs.createWriteStream(destPath);
  const resp = await axios.get(url, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(destPath));
    writer.on('error', reject);
    resp.data.on('error', reject).pipe(writer);
  });
}

module.exports = { createVideoTask, getTaskStatus, extractResultUrl, downloadResult };
