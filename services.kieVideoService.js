const axios = require('axios');
const fs = require('fs');
const path = require('path');
const env = require('./config.env');
const logger = require('./utils.logger');

const client = axios.create({
  baseURL: env.kie.baseUrl,
  headers: { Authorization: `Bearer ${env.kie.apiKey}`, 'Content-Type': 'application/json' },
});

// Kicks off a text-to-video generation job. Returns Kie's taskId (job is async).
async function createVideoTask({ prompt, duration, aspectRatio }) {
  const resp = await client.post('/api/v1/jobs/createTask', {
    model: env.kie.model,
    input: {
      prompt,
      duration: String(duration || '5'),
      aspect_ratio: aspectRatio || '9:16',
    },
  });
  return resp.data.data?.taskId || resp.data.taskId;
}

// state: waiting | queuing | generating | success | fail
async function getTaskStatus(taskId) {
  const resp = await client.get('/api/v1/jobs/recordInfo', { params: { taskId } });
  return resp.data.data || resp.data;
}

async function downloadResult(url, destPath) {
  const writer = fs.createWriteStream(destPath);
  const resp = await client.get(url, { responseType: 'stream', baseURL: undefined });
  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      logger.info(`[video-gen] downloaded result to ${destPath}`);
      resolve(destPath);
    });
    writer.on('error', reject);
    resp.data.on('error', reject).pipe(writer);
  });
}

module.exports = { createVideoTask, getTaskStatus, downloadResult };
