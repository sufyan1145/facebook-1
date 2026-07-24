const { google } = require('googleapis');
const fs = require('fs');
const { getValidYoutubeClient } = require('./services.tokenService');
const logger = require('./utils.logger');

/**
 * Uploads a video to a specific connected YouTube channel (identified by youtubeTokenId,
 * since a user may have connected multiple channels, each its own separate Google login).
 * Vertical AI-generated clips are uploaded as YouTube Shorts by including
 * #Shorts in the title/description, which is how YouTube auto-detects them
 * (no separate "Shorts" API endpoint exists).
 */
async function uploadVideo(userId, youtubeTokenId, filePath, { title, description, tags, privacyStatus }) {
  const auth = await getValidYoutubeClient(userId, youtubeTokenId);
  const youtube = google.youtube({ version: 'v3', auth });

  const shortsTitle = title.length > 90 ? title.slice(0, 87) + '...' : title;

  logger.info(`[youtube] uploading video, title: "${shortsTitle}"`);

  const resp = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: shortsTitle,
        description: `${description || ''}\n\n#Shorts`.trim(),
        tags: tags || [],
        categoryId: '22', // "People & Blogs" - reasonable default for AI documentary-style shorts
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
