const { google } = require('googleapis');
const fs = require('fs');
const { getValidYoutubeClient } = require('./services.tokenService');
const ffmpeg = require('./utils.ffmpeg');
const logger = require('./utils.logger');

const SHORTS_MAX_SECONDS = 180; // YouTube's current Shorts eligibility limit

/**
 * Uploads a video to a specific connected YouTube channel (identified by youtubeTokenId,
 * since a user may have connected multiple channels, each its own separate Google login).
 *
 * videoType controls whether it's tagged as a Short:
 *  - 'shorts' : always add #Shorts (forces Shorts treatment)
 *  - 'long'   : never add #Shorts (regular long-form video)
 *  - 'auto'   : add #Shorts only if the file is within YouTube's Shorts duration limit (<=3 min)
 */
async function uploadVideo(userId, youtubeTokenId, filePath, { title, description, tags, privacyStatus, videoType }) {
  const auth = await getValidYoutubeClient(userId, youtubeTokenId);
  const youtube = google.youtube({ version: 'v3', auth });

  let isShort;
  if (videoType === 'shorts') isShort = true;
  else if (videoType === 'long') isShort = false;
  else {
    try {
      const duration = await ffmpeg.getMediaDuration(filePath);
      isShort = duration <= SHORTS_MAX_SECONDS;
    } catch (e) {
      isShort = true; // if duration can't be read, default to Shorts (matches this app's usual AI clip length)
    }
  }

  const finalTitle = title.length > 90 ? title.slice(0, 87) + '...' : title;
  const finalDescription = isShort ? `${description || ''}\n\n#Shorts`.trim() : (description || '').trim();

  logger.info(`[youtube] uploading video, title: "${finalTitle}", type: ${isShort ? 'Short' : 'Long-form'}`);

  const resp = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: finalTitle,
        description: finalDescription,
        tags: tags || [],
        categoryId: '22', // "People & Blogs" - reasonable default for AI documentary-style content
      },
      status: {
        privacyStatus: privacyStatus || 'public',
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: fs.createReadStream(filePath),
    },
  });

  const videoId = resp.data.id;
  logger.info(`[youtube] uploaded successfully, video id: ${videoId}`);
  return videoId;
}

module.exports = { uploadVideo };
