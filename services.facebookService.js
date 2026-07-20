const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const env = require('./config.env');
const { getValidFacebookToken } = require('./services.tokenService');
const logger = require('./utils.logger');

const GRAPH_URL = `https://graph.facebook.com/${env.facebook.graphVersion}`;

async function getUserPages(userId) {
  const accessToken = await getValidFacebookToken(userId);
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

// Step 1: start a resumable upload session (needs the app id + a USER access token)
async function startUploadSession(userAccessToken, fileName, fileLength) {
  const resp = await axios.post(`${GRAPH_URL}/${env.facebook.appId}/uploads`, null, {
    params: {
      file_name: fileName,
      file_length: fileLength,
      file_type: 'video/mp4',
      access_token: userAccessToken,
    },
  });
  return resp.data.id; // "upload:<SESSION_ID>"
}

// Step 2: push the file bytes to the session, get back a reusable file handle
async function uploadFileChunk(userAccessToken, uploadSessionId, filePath, fileLength) {
  const resp = await axios.post(`${GRAPH_URL}/${uploadSessionId}`, fs.createReadStream(filePath), {
    headers: {
      Authorization: `OAuth ${userAccessToken}`,
      file_offset: '0',
      'Content-Type': 'application/octet-stream',
      'Content-Length': fileLength,
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return resp.data.h; // file handle
}

// Step 3: publish the uploaded handle to the Page using the PAGE access token
async function uploadVideoToPage({ userId, pageId, pageAccessToken, filePath, caption, hashtags, privacy, publishImmediately }) {
  const description = [caption, hashtags].filter(Boolean).join('\n\n');
  const fileLength = fs.statSync(filePath).size;
  const fileName = filePath.split('/').pop();

  try {
    // Steps 1 & 2 authenticate as the connected user, not the page
    const userAccessToken = await getValidFacebookToken(userId);
    const sessionId = await startUploadSession(userAccessToken, fileName, fileLength);
    const fileHandle = await uploadFileChunk(userAccessToken, sessionId, filePath, fileLength);

    const form = new FormData();
    form.append('access_token', pageAccessToken);
    form.append('fbuploader_video_file_chunk', fileHandle);
    if (description) form.append('description', description);
    form.append('published', publishImmediately ? 'true' : 'false');

    const resp = await axios.post(`${GRAPH_URL}/${pageId}/videos`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    logger.info(`Uploaded video to page ${pageId}, fb video id: ${resp.data.id}`);
    return resp.data.id;
  } catch (err) {
    const message = err.response?.data?.error?.message || err.message;
    logger.error(`Facebook upload failed for page ${pageId}: ${message}`);
    throw new Error(message);
  }
}

module.exports = { getUserPages, uploadVideoToPage };
