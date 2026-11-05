// AI thumbnail for long YouTube videos, made with Nano Banana 2 (Vertex).
// 1. take a good frame from the video (so the thumbnail shows the real subject)
// 2. ask Nano Banana to turn it into a bold, high-contrast 16:9 thumbnail with
//    a short headline taken from the video title
// 3. save as 1280x720 JPEG under 2 MB (YouTube's limit)
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const logger = require('./utils.logger');
const ffmpeg = require('./utils.ffmpeg');
const vertexAiService = require('./services.vertexAiService');

const MAX_BYTES = 2 * 1024 * 1024;

function enabled() {
  return String(process.env.YOUTUBE_AI_THUMBNAIL || 'true').toLowerCase() !== 'false';
}

function buildPrompt(title) {
  return [
    'Turn this video frame into an eye-catching YouTube thumbnail, 16:9 landscape.',
    'Keep the same main subject and scene as the picture, but make it dramatic: vivid saturated colours, strong contrast, clean bright lighting, subject large and clearly visible.',
    `Add a short bold headline of at most 4 words, big and easy to read on a phone, based on this video title: "${String(title || '').slice(0, 120)}".`,
    'Write the headline in the same language as the title, spelled exactly right. Thick outlined letters with a contrasting colour.',
    'No logos, no watermarks, no small text, no extra captions.',
  ].join(' ');
}

async function grabFrame(videoPath, destJpg) {
  let dur = 0;
  try { dur = await ffmpeg.getMediaDuration(videoPath); } catch (_) { /* use start */ }
  // 20% in: past the intro, before the end card
  const at = dur > 20 ? Math.min(dur * 0.2, 300) : 1;
  await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(at), '-i', videoPath, '-frames:v', '1', '-q:v', '2', destJpg]);
  if (!fs.existsSync(destJpg)) throw new Error('Could not take a frame from the video');
}

// Any image -> exactly 1280x720 JPEG below 2 MB.
async function toThumbnailJpeg(src, dest) {
  for (const q of [3, 5, 8, 12]) {
    await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', 'scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720', '-frames:v', '1', '-q:v', String(q), dest]);
    if (fs.statSync(dest).size <= MAX_BYTES) return dest;
  }
  throw new Error('Thumbnail is larger than 2 MB even at low quality');
}

/**
 * @returns {Promise<string>} path of the finished thumbnail (JPEG)
 */
async function createThumbnail(videoPath, title, destJpg) {
  const dir = path.dirname(destJpg);
  const base = path.basename(destJpg, path.extname(destJpg));
  const frame = path.join(dir, `${base}_frame.jpg`);
  const raw = path.join(dir, `${base}_ai.png`);
  try {
    await grabFrame(videoPath, frame);
    await vertexAiService.generateImage(buildPrompt(title), raw, { referenceImagePath: frame });
    return await toThumbnailJpeg(raw, destJpg);
  } finally {
    [frame, raw].forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });
  }
}

module.exports = { createThumbnail, enabled, buildPrompt };
