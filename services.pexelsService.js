const axios = require('axios');
const fs = require('fs');
const env = require('./config.env');
const logger = require('./utils.logger');

const client = axios.create({
  baseURL: 'https://api.pexels.com',
  headers: { Authorization: env.pexels.apiKey },
});

// Searches Pexels for a video matching the query in the given orientation and
// returns a direct downloadable file URL (prefers a smaller HD file over the
// full 4K original).
async function searchVideoUrl(query, orientation = 'portrait') {
  const resp = await client.get('/videos/search', {
    params: { query, orientation, per_page: 5 },
  });

  const videos = resp.data.videos || [];
  if (!videos.length) {
    throw new Error(`Pexels found no stock video for "${query}"`);
  }

  // Prefer a reasonably-sized file matching the target orientation (avoid the huge 4K original file).
  const video = videos[0];
  const files = (video.video_files || []).filter((f) => f.file_type === 'video/mp4');
  const inRange =
    orientation === 'landscape'
      ? (f) => f.width >= 1280 && f.width <= 1920
      : (f) => f.height >= 1280 && f.height <= 1920;
  const preferred = files.find(inRange) || files.sort((a, b) => (b.height || 0) - (a.height || 0))[0];

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
