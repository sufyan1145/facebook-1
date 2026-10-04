/**
 * Posts a video to Instagram (as a Reel) via the Instagram Graph API.
 *
 * Unlike Facebook's uploadVideoToPage (services.facebookService.js), which
 * uploads the file's bytes directly in chunks, Instagram's Content
 * Publishing API only accepts a PUBLICLY REACHABLE URL for the video -
 * Instagram's own servers fetch it from there, in the background. So the
 * caller must first make the file reachable at a public URL (see
 * routes.mediaPublic.js, a short-lived unauthenticated file-serving route
 * built for exactly this) before calling this.
 *
 * Flow (all using the Page Access Token of the Facebook Page the Instagram
 * account is linked to - same token already stored in the `pages` table,
 * no separate Instagram login needed):
 *   1. POST /{ig-user-id}/media  (video_url, caption)      -> { id: creationId }
 *   2. GET  /{creationId}?fields=status_code                -> poll until FINISHED
 *   3. POST /{ig-user-id}/media_publish  (creation_id)      -> { id: mediaId }
 */
const axios = require('axios');
const env = require('./config.env');
const logger = require('./utils.logger');

const GRAPH_URL = `https://graph.facebook.com/${env.facebook.graphVersion}`;

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // Instagram's own fetch+processing of the video, usually well under this

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createMediaContainer(instagramUserId, pageAccessToken, videoUrl, caption) {
  const resp = await axios.post(`${GRAPH_URL}/${instagramUserId}/media`, null, {
    params: {
      video_url: videoUrl,
      caption: caption || '',
      media_type: 'REELS',
      access_token: pageAccessToken,
    },
  });
  return resp.data.id;
}

async function waitForContainerReady(creationId, pageAccessToken) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const resp = await axios.get(`${GRAPH_URL}/${creationId}`, {
      params: { fields: 'status_code,status', access_token: pageAccessToken },
    });
    const { status_code: statusCode, status } = resp.data;
    if (statusCode === 'FINISHED') return;
    if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
      throw new Error(`Instagram rejected the video (${statusCode}): ${status || 'no detail given'}`);
    }
    // IN_PROGRESS / PUBLISHED-pending - keep waiting
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Instagram video processing did not finish within ${POLL_TIMEOUT_MS / 60000} minutes`);
}

async function publishMediaContainer(instagramUserId, pageAccessToken, creationId) {
  const resp = await axios.post(`${GRAPH_URL}/${instagramUserId}/media_publish`, null, {
    params: { creation_id: creationId, access_token: pageAccessToken },
  });
  return resp.data.id;
}

/**
 * @param {string} instagramUserId - the page's linked Instagram Business Account id (pages.instagram_business_account_id)
 * @param {string} pageAccessToken - the Facebook Page's access token (same one used for Facebook posting)
 * @param {string} videoUrl - a public URL Instagram's servers can fetch the video from
 * @param {string} caption - post caption (hashtags can just be included in this text)
 * @returns {Promise<string>} the published Instagram media id
 */
async function uploadVideoToInstagram({ instagramUserId, pageAccessToken, videoUrl, caption }) {
  if (!instagramUserId) throw new Error('This Facebook Page has no linked Instagram Business/Creator account');

  logger.info(`[instagram] creating media container for IG account ${instagramUserId}`);
  let creationId;
  try {
    creationId = await createMediaContainer(instagramUserId, pageAccessToken, videoUrl, caption);
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    throw new Error(`Instagram container creation failed: ${detail}`);
  }

  logger.info(`[instagram] waiting for container ${creationId} to finish processing`);
  await waitForContainerReady(creationId, pageAccessToken);

  logger.info(`[instagram] publishing container ${creationId}`);
  let mediaId;
  try {
    mediaId = await publishMediaContainer(instagramUserId, pageAccessToken, creationId);
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    throw new Error(`Instagram publish failed: ${detail}`);
  }

  logger.info(`[instagram] published, media id ${mediaId}`);
  return mediaId;
}

module.exports = { uploadVideoToInstagram };
