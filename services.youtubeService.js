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

/**
 * Sets a custom thumbnail on an uploaded video (JPEG/PNG, max 2 MB).
 * Needs a verified YouTube channel (YouTube rule, not ours); the existing
 * youtube.upload permission is enough.
 */
async function uploadThumbnail(userId, youtubeTokenId, videoId, imagePath) {
  const auth = await getValidYoutubeClient(userId, youtubeTokenId);
  const youtube = google.youtube({ version: 'v3', auth });
  await youtube.thumbnails.set({
    videoId,
    media: { mimeType: /\.png$/i.test(imagePath) ? 'image/png' : 'image/jpeg', body: fs.createReadStream(imagePath) },
  });
  logger.info(`[youtube] custom thumbnail set for video ${videoId}`);
}

// Same rule uploadVideo uses to decide Short vs long-form.
async function isLongVideo(filePath, videoType) {
  if (videoType === 'shorts') return false;
  if (videoType === 'long') return true;
  try {
    return (await ffmpeg.getMediaDuration(filePath)) > SHORTS_MAX_SECONDS;
  } catch (e) {
    return false;
  }
}

// Posts a top-level comment on the channel's own video (e.g. a link). The YouTube API can
// create comments but cannot pin them - pinning stays a one-tap action in YouTube Studio.
// Needs the youtube.force-ssl scope: channels connected before that scope was added must be reconnected.
async function postVideoComment(userId, youtubeTokenId, videoId, text) {
  const auth = await getValidYoutubeClient(userId, youtubeTokenId);
  const youtube = google.youtube({ version: 'v3', auth });
  try {
    const { data } = await youtube.commentThreads.insert({
      part: ['snippet'],
      requestBody: { snippet: { videoId, topLevelComment: { snippet: { textOriginal: text } } } },
    });
    logger.info(`[youtube] comment posted on video ${videoId} (comment ${data.id})`);
    return data.id;
  } catch (err) {
    const reason = err.errors && err.errors[0] && err.errors[0].reason;
    if (err.code === 403 || reason === 'insufficientPermissions' || /insufficient/i.test(err.message)) {
      throw new Error('YouTube refused the comment (permission missing) - disconnect and connect this YouTube channel again so it can ask for the comment permission');
    }
    throw err;
  }
}

module.exports = { uploadVideo, uploadThumbnail, isLongVideo, postVideoComment };
