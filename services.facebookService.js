const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const env = require('./config.env');
const { getValidFacebookToken } = require('./services.tokenService');
const logger = require('./utils.logger');

const GRAPH_URL = `https://graph.facebook.com/${env.facebook.graphVersion}`;

async function getUserPages(userId, facebookTokenId) {
  const accessToken = await getValidFacebookToken(userId, facebookTokenId);
  const resp = await axios.get(`${GRAPH_URL}/me/accounts`, {
    params: { access_token: accessToken, fields: 'id,name,access_token,followers_count' },
  });
  return (resp.data.data || []).map((p) => ({
    id: p.id,
    name: p.name,
    access_token: p.access_token,
    followers: p.followers_count || 0,
  }));
}

const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB per chunk

// Phase 1: start a chunked upload session directly on the page's videos edge
async function startChunkedUpload(pageId, pageAccessToken, fileSize) {
  const resp = await axios.post(`${GRAPH_URL}/${pageId}/videos`, null, {
    params: {
      upload_phase: 'start',
      file_size: fileSize,
      access_token: pageAccessToken,
    },
  });
  return resp.data; // { upload_session_id, video_id, start_offset, end_offset }
}

// Phase 2: transfer the file in chunks until the server has consumed all bytes
async function transferChunks(pageId, pageAccessToken, filePath, sessionId, startOffset, endOffset) {
  const fd = fs.openSync(filePath, 'r');
  try {
    let offset = startOffset;
    let nextEnd = endOffset;
    while (offset < nextEnd) {
      const chunkLength = Math.min(CHUNK_SIZE, nextEnd - offset);
      const buffer = Buffer.alloc(chunkLength);
      fs.readSync(fd, buffer, 0, chunkLength, offset);

      const form = new FormData();
      form.append('upload_phase', 'transfer');
      form.append('start_offset', String(offset));
      form.append('upload_session_id', sessionId);
      form.append('access_token', pageAccessToken);
      form.append('video_file_chunk', buffer, { filename: 'chunk.mp4' });

      const resp = await axios.post(`${GRAPH_URL}/${pageId}/videos`, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });
      offset = Number(resp.data.start_offset);
      nextEnd = Number(resp.data.end_offset);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Phase 3: finalize the session so the video gets published
async function finishChunkedUpload(pageId, pageAccessToken, sessionId, description, publishImmediately) {
  const form = new FormData();
  form.append('upload_phase', 'finish');
  form.append('upload_session_id', sessionId);
  form.append('access_token', pageAccessToken);
  if (description) form.append('description', description);
  form.append('published', publishImmediately ? 'true' : 'false');

  const resp = await axios.post(`${GRAPH_URL}/${pageId}/videos`, form, {
    headers: form.getHeaders(),
  });
  return resp.data;
}

async function uploadVideoToPage({ pageId, pageAccessToken, filePath, caption, hashtags, privacy, publishImmediately }) {
  const description = [caption, hashtags].filter(Boolean).join('\n\n');
  const fileSize = fs.statSync(filePath).size;

  let step = 'phase_start';
  try {
    const { upload_session_id: sessionId, video_id: videoId, start_offset, end_offset } =
      await startChunkedUpload(pageId, pageAccessToken, fileSize);
    logger.info(`[FB upload] start ok, session=${sessionId}, video_id=${videoId}, fileSize=${fileSize}`);

    step = 'phase_transfer';
    await transferChunks(pageId, pageAccessToken, filePath, sessionId, Number(start_offset), Number(end_offset));
    logger.info(`[FB upload] transfer ok, session=${sessionId}`);

    step = 'phase_finish';
    await finishChunkedUpload(pageId, pageAccessToken, sessionId, description, publishImmediately);
    logger.info(`Uploaded video to page ${pageId}, fb video id: ${videoId}`);
    return videoId;
  } catch (err) {
    const fbError = err.response?.data?.error;
    logger.error(
      `[FB upload] FAILED at ${step} for page ${pageId}: ${JSON.stringify(fbError || err.message)}`
    );
    const message = fbError?.message || err.message;
    throw new Error(`[${step}] ${message}`);
  }
}

module.exports = { getUserPages, uploadVideoToPage };
