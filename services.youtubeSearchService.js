/**
 * Public YouTube search (search.list) using a simple API key - separate from
 * services.youtubeService.js, which uses per-user OAuth for uploading. This
 * is read-only, used by the Product Explainer feature to find real footage
 * of a product from other creators' videos.
 *
 * Quota note: search.list costs 100 units per call against a 10,000
 * unit/day free quota - only ~100 searches/day. services.productExplainerService.js
 * groups multiple narration lines per search (see config.env.js
 * productExplainer.linesPerSearchGroup) specifically to stay well under this.
 */
const { google } = require('googleapis');
const env = require('./config.env');
const logger = require('./utils.logger');

/**
 * @param {string} query - search terms (e.g. "blender crushing ice powerful motor")
 * @param {number} maxResults - how many candidate videos to return
 * @returns {Array<{videoId, title, url}>}
 */
async function searchVideos(query, maxResults = 3) {
  if (!env.productExplainer.youtubeSearchApiKey) {
    throw new Error('YOUTUBE_SEARCH_API_KEY is not configured');
  }
  const youtube = google.youtube({ version: 'v3', auth: env.productExplainer.youtubeSearchApiKey });

  const res = await youtube.search.list({
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults,
    videoEmbeddable: 'true',
    safeSearch: 'strict',
  });

  const items = res.data.items || [];
  logger.info(`[youtube-search] "${query}" -> ${items.length} result(s)`);
  return items.map((item) => ({
    videoId: item.id.videoId,
    title: item.snippet.title,
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
  }));
}

module.exports = { searchVideos };
