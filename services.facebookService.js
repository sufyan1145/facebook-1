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

async function uploadVideoToPage({ pageId, pageAccessToken, filePath, caption, hashtags, privacy, publishImmediately }) {
  const description = [caption, hashtags].filter(Boolean).join('\n\n');

  const form = new FormData();
  form.append('access_token', pageAccessToken);
  form.append('source', fs.createReadStream(filePath));
  if (description) form.append('description', description);
  form.append('published', publishImmediately ? 'true' : 'false');

  try {
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
