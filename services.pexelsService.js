const axios = require('axios');
const fs = require('fs');
const env = require('./config.env');
const logger = require('./utils.logger');

const client = axios.create({
  baseURL: 'https://api.pexels.com',
  headers: { Authorization: env.pexels.apiKey },
});

// Searches Pexels for a portrait video matching the query and returns a direct
// downloadable file URL (prefers a smaller HD file over the full 4K original).
async function searchVideoUrl(query) {
  const resp = await client.get('/videos/search', {
    params: { query, orientation: 'portrait', per_page: 5 },
  });

  const videos = resp.data.videos || [];
  if (!videos.length) {
    throw new Error(`Pexels found no stock video for "${query}"`);
  }

  // Prefer a reasonably-sized portrait mp4 (avoid the huge 4K original file).
  const video = videos[0];
  const files = (video.video_files || []).filter((f) => f.file_type === 'video/mp4');
  const preferred =
    files.find((f) => f.height >= 1280 && f.height <= 1920) || files.sort((a, b) => (b.height || 0) - (a.height || 0))[0];

  if (!preferred) {
    throw new Error(`Pexels result for "${query}" had no usable video file`);
  }
  return preferred.link;
}

async function downloadVideo(url, destPath) {
  const writer = fs.createWriteStream(destPath);
  const resp = await axios.get(url, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      logger.info(`[pexels] downloaded stock clip to ${destPath}`);
      resolve(destPath);
    });
    writer.on('error', reject);
    resp.data.on('error', reject).pipe(writer);
  });
}

module.exports = { searchVideoUrl, downloadVideo };
