const axios = require('axios');
const fs = require('fs');
const { GoogleAuth } = require('google-auth-library');
const env = require('./config.env');
const logger = require('./utils.logger');

let authClient = null;

function getAuth() {
  if (!authClient) {
    if (!env.vertexAi.credentialsBase64) {
      throw new Error('VERTEX_CREDENTIALS_BASE64 is not set');
    }
    const credentials = JSON.parse(Buffer.from(env.vertexAi.credentialsBase64, 'base64').toString('utf8'));
    authClient = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }
  return authClient;
}

async function getAccessToken() {
  const client = await getAuth().getClient();
  const token = await client.getAccessToken();
  return typeof token === 'string' ? token : token.token;
}

function baseUrl() {
  return `https://${env.vertexAi.location}-aiplatform.googleapis.com/v1/projects/${env.vertexAi.projectId}/locations/${env.vertexAi.location}/publishers/google/models`;
}

// ---- Veo3 video generation ----

async function createVeoVideoTask({ prompt, duration, aspectRatio }) {
  const token = await getAccessToken();
  const requestBody = {
    instances: [{ prompt }],
    parameters: {
      aspectRatio: aspectRatio || '9:16',
      durationSeconds: String(Math.min(Math.round(duration), 8)),
      generateAudio: false,
      resolution: '720p',
    },
  };
  logger.info(`[vertex] veo generate request: ${JSON.stringify(requestBody)}, url: ${baseUrl()}/${env.vertexAi.veoModel}:predictLongRunning`);

  let resp;
  try {
    resp = await axios.post(
      `${baseUrl()}/${env.vertexAi.veoModel}:predictLongRunning`,
      requestBody,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const detail = err.response?.data;
    logger.error(`[vertex] veo generate FAILED: status=${err.response?.status} detail=${JSON.stringify(detail)}`);
    throw new Error(detail?.error?.message || err.message);
  }
  logger.info(`[vertex] veo generate response: ${JSON.stringify(resp.data)}`);

  const operationName = resp.data.name;
  if (!operationName) throw new Error(`Vertex AI did not return an operation name: ${JSON.stringify(resp.data)}`);
  return operationName;
}

async function getVeoOperationStatus(operationName) {
  const token = await getAccessToken();
  const resp = await axios.post(
    `${baseUrl()}/${env.vertexAi.veoModel}:fetchPredictOperation`,
    { operationName },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return resp.data;
}

function extractVeoResultBytes(status) {
  const video = status.response?.videos?.[0];
  return video?.bytesBase64Encoded || null;
}

// ---- Nano Banana (Gemini image) via Vertex ----

async function generateImage(prompt, destPath) {
  const token = await getAccessToken();
  let resp;
  try {
    resp = await axios.post(
      `${baseUrl()}/${env.vertexAi.imageModel}:generateContent`,
      {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'] },
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const detail = err.response?.data;
    logger.error(`[vertex] image generate FAILED: status=${err.response?.status} detail=${JSON.stringify(detail)}`);
    throw new Error(detail?.error?.message || err.message);
  }

  const parts = resp.data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart) throw new Error('Vertex AI returned no image data');

  fs.writeFileSync(destPath, Buffer.from(imagePart.inlineData.data, 'base64'));
  return destPath;
}

// ---- Cloud Text-to-Speech (separate, simpler Google Cloud API) ----

async function synthesizeSpeech(text, destPath, voiceName) {
  const token = await getAccessToken();
  const chirpVoiceName = `en-US-Chirp3-HD-${voiceName || 'Charon'}`;
  const resp = await axios.post(
    'https://texttospeech.googleapis.com/v1/text:synthesize',
    {
      input: { text },
      voice: { languageCode: 'en-US', name: chirpVoiceName },
      audioConfig: { audioEncoding: 'MP3' },
    },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );

  if (!resp.data.audioContent) throw new Error('Cloud Text-to-Speech returned no audio');
  fs.writeFileSync(destPath, Buffer.from(resp.data.audioContent, 'base64'));
  return destPath;
}

module.exports = {
  createVeoVideoTask,
  getVeoOperationStatus,
  extractVeoResultBytes,
  generateImage,
  synthesizeSpeech,
};
