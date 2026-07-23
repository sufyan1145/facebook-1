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
  const requestBody = {
    model: env.kie.model,
    input: {
      prompt,
      duration: String(duration || '5'),
      aspect_ratio: aspectRatio || '9:16',
      sound: false,
    },
  };
  logger.info(`[video-gen] createTask request: ${JSON.stringify(requestBody)}`);
  const resp = await client.post('/api/v1/jobs/createTask', requestBody);

  const body = resp.data;
  logger.info(`[video-gen] createTask response: ${JSON.stringify(body)}`);

  // Kie.ai returns HTTP 200 even on internal failures, with a non-success `code`
  if (body.code !== undefined && body.code !== 200 && body.code !== 0) {
    throw new Error(body.msg || body.message || `Kie.ai rejected the request (code ${body.code})`);
  }

  const taskId = body.data?.taskId || body.taskId;
  if (!taskId) {
    throw new Error(`Kie.ai did not return a taskId: ${JSON.stringify(body)}`);
  }
  return taskId;
}

// state: waiting | queuing | generating | success | fail
async function getTaskStatus(taskId) {
  const resp = await client.get('/api/v1/jobs/recordInfo', { params: { taskId } });
  const body = resp.data;

  if (body.code !== undefined && body.code !== 200 && body.code !== 0) {
    throw new Error(body.msg || body.message || `Kie.ai rejected the status check (code ${body.code})`);
  }

  return body.data || body;
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

function extractResultUrl(statusData) {
  let rj = statusData.resultJson;
  if (typeof rj === 'string') {
    try {
      rj = JSON.parse(rj);
    } catch (e) {
      rj = null;
    }
  }
  if (!rj) return null;
  return (rj.resultUrls && rj.resultUrls[0]) || (rj.urls && rj.urls[0]) || rj.url || null;
}

module.exports = { createVideoTask, getTaskStatus, downloadResult, extractResultUrl };
