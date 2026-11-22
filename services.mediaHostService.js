/**
 * Gives a local video file a short-lived public URL on the web app (Instagram has to download the video itself).
 * Works when the worker runs in a separate container: the file is pushed to the web app over HTTPS (signed request).
 */
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const env = require('./config.env');

const sigFor = (token) => crypto.createHmac('sha256', String(env.tokenEncryptionKey || 'k')).update(`media:${token}`).digest('hex');

async function hostVideo(filePath) {
  const base = String(env.appUrl).replace(/\/+$/, '');
  const token = crypto.randomBytes(24).toString('hex');
  const size = fs.statSync(filePath).size;
  const headers = { 'x-media-sig': sigFor(token) };
  try {
    await axios.put(`${base}/media-temp/upload/${token}`, fs.createReadStream(filePath), {
      headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': size },
      maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 15 * 60 * 1000,
    });
  } catch (err) {
    const status = err.response && err.response.status;
    throw new Error(`Could not hand the video to the web server for Instagram (${status || err.message}). Check that APP_URL points to your public web address.`);
  }
  return {
    url: `${base}/media-temp/${token}.mp4`,
    cleanup: () => axios.delete(`${base}/media-temp/${token}`, { headers, timeout: 20000 }).catch(() => {}),
  };
}

module.exports = { hostVideo };
