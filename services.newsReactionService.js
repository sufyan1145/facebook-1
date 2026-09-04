/**
 * News Reaction / Explainer builder for the Video Editor.
 *
 * Fixed rhythm, repeating for the WHOLE source video: a ~10s narrated
 * "image" beat (AI image, or a real frame walked sequentially through the
 * source video, Ken-Burns animated), then a ~4s "clip" beat where the
 * *original* footage plays as itself (its own audio, no narration on top).
 * This repeats block-by-block until the whole source video has been walked
 * through, rather than jumping between a handful of AI-picked highlights.
 *
 * Image generation order: Gemini (Nano Banana, free-tier) first -> if that
 * fails for any reason, a real frame pulled from the source video at that
 * block's position (free, always available, and literally "a deserving
 * scene" from the same video) -> Pollinations only as a last-resort safety
 * net if even frame extraction somehow fails.
 *
 * Supports both portrait (Reels/Shorts, 1080x1920) and landscape (YouTube
 * long-form, 1920x1080) output via the `orientation` option.
 *
 * IMPORTANT (same note as utils.autoHighlight.js and geminiService's
 * generateReactionNarrationLines): keeping clip bursts short and always
 * narrating over the image beats is what keeps this meaningfully different
 * from a straight repost - it reduces automated fingerprint-match /
 * straight-repost risk. It does NOT make reposting someone else's footage
 * legal on its own.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./utils.logger');
const env = require('./config.env');
const geminiService = require('./services.geminiService');
const pollinationsService = require('./services.pollinationsService');
const googleTtsService = require('./services.googleTtsService');
const customTtsService = require('./services.customTtsService');
const vertexAiService = require('./services.vertexAiService');
const ffmpeg = require('./utils.ffmpeg');

// The fixed rhythm the whole video follows, per the requested format.
const IMAGE_SECONDS = 10;
const CLIP_SECONDS = 4;
const BLOCK_SECONDS = IMAGE_SECONDS + CLIP_SECONDS;

const ORIENTATIONS = {
  portrait: { width: 1080, height: 1920 }, // Reels / Shorts / TikTok-style
  landscape: { width: 1920, height: 1080 }, // YouTube long-form
};

// Cycle through effects so the video doesn't look like the same repeated
// zoom on every image beat (same idea as jobs.contentPipelineWorker.js).
const KEN_BURNS_EFFECTS = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'popup'];

async function synthesizeNarration(text, destPath, voiceName) {
  // Same provider selection as jobs.contentPipelineWorker.js, so this
  // respects whichever TTS provider is already configured for the app.
  if (env.contentPipeline.ttsProvider === 'vertex') {
    return vertexAiService.synthesizeSpeech(text, destPath, voiceName);
  }
  if (env.contentPipeline.ttsProvider === 'custom') {
    return customTtsService.synthesizeSpeech(text, destPath, voiceName);
  }
  return googleTtsService.synthesizeToFile(text, destPath, voiceName);
}

async function generateBlockImage(prompt, destPath, { sourcePath, fallbackTimestamp, width, height }) {
  // 1st choice: Gemini (Nano Banana) - better quality, still free-tier via
  // the same GEMINI_API_KEY already used elsewhere in this app.
  try {
    await geminiService.generateImage(prompt, destPath, { retries: 0 });
    return destPath;
  } catch (err) {
    logger.info(`[news-reaction] Gemini image generation failed (${err.message}), falling back to a real frame from the source video`);
  }

  // 2nd choice: a real frame from THIS video at this block's position in the
  // story - free, instant, always available, and literally a "deserving
  // scene" from the same footage rather than a generic stock/AI image.
  try {
    await ffmpeg.extractFrame(sourcePath, fallbackTimestamp, destPath);
    return destPath;
  } catch (err) {
    logger.info(`[news-reaction] real-frame fallback also failed (${err.message}), falling back to Pollinations`);
  }

  // 3rd choice (last resort): Pollinations, free/no-key.
  await pollinationsService.generateImage(prompt, destPath, width, height);
  return destPath;
}

/**
 * @param {string} sourcePath - already-downloaded source video (mp4)
 * @param {string} tempDir - scratch directory for intermediate files
 * @param {string} jobId - used only to namespace temp filenames
 * @param {object} opts - { title, description, voiceName, narrationLanguage, orientation }
 *   orientation: 'portrait' (default, Reels/Shorts) | 'landscape' (YouTube long-form)
 * @returns {{ finalPath: string, blockCount: number }}
 */
async function buildNewsReactionVideo(sourcePath, tempDir, jobId, { title, description, voiceName, narrationLanguage, orientation = 'portrait' } = {}) {
  const { width, height } = ORIENTATIONS[orientation] || ORIENTATIONS.portrait;
  const totalDuration = await ffmpeg.getMediaDuration(sourcePath);

  const numBlocks = Math.max(1, Math.round(totalDuration / BLOCK_SECONDS));
  logger.info(`[news-reaction] job ${jobId}: source is ${totalDuration.toFixed(1)}s (${orientation}), planning ${numBlocks} blocks (${IMAGE_SECONDS}s image + ${CLIP_SECONDS}s clip each), requesting narration`);

  const { lines } = await geminiService.generateReactionNarrationLines(title, description, numBlocks, { narrationLanguage });
  logger.info(`[news-reaction] job ${jobId}: got ${lines.length} narration lines`);

  const clipPaths = [];
  const audioPaths = [];
  const tempFiles = [];

  for (let i = 0; i < numBlocks; i++) {
    // Walk sequentially through the source video - one proportional point
    // per block - so both the image "deserving scene" fallback and the clip
    // burst progress through the whole story instead of repeating one spot.
    const pointInSource = (i / numBlocks) * totalDuration;

    // --- Image beat (~10s target; exact length follows this line's actual spoken duration) ---
    const narrationPath = path.join(tempDir, `${jobId}_reaction_narration_${i}.mp3`);
    await synthesizeNarration(lines[i], narrationPath, voiceName);
    tempFiles.push(narrationPath);
    const narrationDuration = await ffmpeg.getMediaDuration(narrationPath);

    const imagePath = path.join(tempDir, `${jobId}_reaction_image_${i}.png`);
    await generateBlockImage(lines[i], imagePath, { sourcePath, fallbackTimestamp: pointInSource, width, height });
    tempFiles.push(imagePath);

    const imageClipPath = path.join(tempDir, `${jobId}_reaction_visual_img_${i}.mp4`);
    const effect = KEN_BURNS_EFFECTS[i % KEN_BURNS_EFFECTS.length];
    await ffmpeg.imageToKenBurnsClip(imagePath, narrationDuration, imageClipPath, width, height, effect);
    tempFiles.push(imageClipPath);
    clipPaths.push(imageClipPath);
    audioPaths.push(narrationPath);

    // --- Clip beat (~4s of the real original clip, its own normal-volume audio, no narration) ---
    const remaining = Math.max(0.5, totalDuration - pointInSource);
    const clipDuration = Math.min(CLIP_SECONDS, remaining);

    const clipVisualPath = path.join(tempDir, `${jobId}_reaction_visual_clip_${i}.mp4`);
    await ffmpeg.trimSilentClip(sourcePath, pointInSource, clipDuration, clipVisualPath, width, height);
    tempFiles.push(clipVisualPath);
    clipPaths.push(clipVisualPath);

    const clipAudioPath = path.join(tempDir, `${jobId}_reaction_audio_clip_${i}.mp3`);
    try {
      await ffmpeg.extractAudioSegment(sourcePath, pointInSource, clipDuration, clipAudioPath);
    } catch (err) {
      // Rare: this stretch of the source has no audio stream at all.
      logger.info(`[news-reaction] job ${jobId}: block ${i + 1} clip beat has no source audio, using silence`);
      await ffmpeg.generateSilentAudio(clipDuration, clipAudioPath);
    }
    tempFiles.push(clipAudioPath);
    audioPaths.push(clipAudioPath);

    logger.info(`[news-reaction] job ${jobId}: block ${i + 1}/${numBlocks} done (image ${narrationDuration.toFixed(1)}s + clip ${clipDuration.toFixed(1)}s)`);
  }

  const stitchedVideoPath = path.join(tempDir, `${jobId}_reaction_video.mp4`);
  await ffmpeg.concatClips(clipPaths, stitchedVideoPath);
  tempFiles.push(stitchedVideoPath);

  const stitchedAudioPath = path.join(tempDir, `${jobId}_reaction_audio.mp3`);
  await ffmpeg.concatAudio(audioPaths, stitchedAudioPath);
  tempFiles.push(stitchedAudioPath);

  const finalPath = path.join(tempDir, `${jobId}_reaction_final.mp4`);
  await ffmpeg.mergeAudioVideo(stitchedVideoPath, stitchedAudioPath, finalPath);

  tempFiles.forEach((f) => { if (f !== finalPath) fs.unlink(f, () => {}); });

  return { finalPath, blockCount: numBlocks };
}

module.exports = { buildNewsReactionVideo };
