/**
 * News Reaction / Explainer builder for the Video Editor.
 *
 * Turns a downloaded source video into a narrated reaction/explainer: an AI
 * script (geminiService.generateReactionScript) alternates short bursts of
 * the *original* clip (original audio kept, but quiet, under the narration)
 * with narrated still-image scenes (AI-generated or a real frame pulled
 * from the source - the AI picks per scene), Ken-Burns animated. Each
 * scene's visual length is driven by its own narration's actual spoken
 * length (same pattern as jobs.contentPipelineWorker.js), so visuals and
 * voiceover always line up exactly. Everything is stitched into one silent
 * video track + one audio track, then merged.
 *
 * IMPORTANT (same note as utils.autoHighlight.js and geminiService's
 * generateReactionScript): keeping clip bursts short and always narrating
 * over them meaningfully reduces automated fingerprint-match / straight-
 * repost risk - it does NOT make reposting someone else's footage legal on
 * its own.
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

// Cycle through effects so the video doesn't look like the same repeated
// zoom on every image scene (same idea as jobs.contentPipelineWorker.js).
const KEN_BURNS_EFFECTS = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down', 'popup'];

const BACKGROUND_VOLUME = 0.15; // "halka" original audio under clip-burst narration

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

async function generateSceneImage(prompt, destPath) {
  // Gemini (Nano Banana) first - better quality, still free-tier via the
  // same GEMINI_API_KEY already used elsewhere in this app. If it fails for
  // ANY reason (quota, 503 overload, retired model, network issue, etc.),
  // instantly fall back to Pollinations (free, no key, no quota) instead of
  // failing the whole scene/job.
  try {
    await geminiService.generateImage(prompt, destPath, { retries: 0 });
    return destPath;
  } catch (err) {
    logger.info(`[news-reaction] Gemini image generation failed (${err.message}), falling back to Pollinations`);
    await pollinationsService.generateImage(prompt, destPath, 1080, 1920);
    return destPath;
  }
}

/**
 * @param {string} sourcePath - already-downloaded source video (mp4)
 * @param {string} tempDir - scratch directory for intermediate files
 * @param {string} jobId - used only to namespace temp filenames
 * @param {object} opts - { title, description, voiceName, narrationLanguage }
 * @returns {{ finalPath: string, sceneCount: number }}
 */
async function buildNewsReactionVideo(sourcePath, tempDir, jobId, { title, description, voiceName, narrationLanguage } = {}) {
  const totalDuration = await ffmpeg.getMediaDuration(sourcePath);
  logger.info(`[news-reaction] job ${jobId}: source is ${totalDuration.toFixed(1)}s, requesting script`);
  const script = await geminiService.generateReactionScript(title, description, totalDuration, { narrationLanguage });
  logger.info(`[news-reaction] job ${jobId}: got ${script.scenes.length} scenes`);

  const clipPaths = [];
  const audioPaths = [];
  const tempFiles = [];

  for (let i = 0; i < script.scenes.length; i++) {
    const scene = script.scenes[i];

    // 1. Narration first - its actual spoken duration drives this scene's
    //    visual length (never the other way around; stretching real video
    //    footage to match a duration warps its speed/pitch).
    const narrationPath = path.join(tempDir, `${jobId}_reaction_narration_${i}.mp3`);
    await synthesizeNarration(scene.narration, narrationPath, voiceName);
    tempFiles.push(narrationPath);
    const narrationDuration = await ffmpeg.getMediaDuration(narrationPath);

    const clipPath = path.join(tempDir, `${jobId}_reaction_visual_${i}.mp4`);

    if (scene.type === 'clip') {
      // Original footage burst: video trimmed silently, audio rebuilt as
      // narration-on-top + quiet original underneath (see
      // utils.ffmpeg.mixNarrationWithBackground).
      await ffmpeg.trimSilentClip(sourcePath, scene.startTime, narrationDuration, clipPath);
      const mixedAudioPath = path.join(tempDir, `${jobId}_reaction_audio_${i}.mp3`);
      await ffmpeg.mixNarrationWithBackground(narrationPath, sourcePath, scene.startTime, narrationDuration, mixedAudioPath, BACKGROUND_VOLUME);
      tempFiles.push(mixedAudioPath);
      audioPaths.push(mixedAudioPath);
    } else {
      // Image scene: either a real frame pulled from the source, or an
      // AI-generated illustration - either way, animated with Ken Burns to
      // exactly the narration's length. Plain narration audio, no mixing.
      const imagePath = path.join(tempDir, `${jobId}_reaction_image_${i}.png`);
      if (scene.imageSource === 'real_frame') {
        await ffmpeg.extractFrame(sourcePath, scene.atTime, imagePath);
      } else {
        await generateSceneImage(scene.imagePrompt || scene.narration, imagePath);
      }
      tempFiles.push(imagePath);
      const effect = KEN_BURNS_EFFECTS[i % KEN_BURNS_EFFECTS.length];
      await ffmpeg.imageToKenBurnsClip(imagePath, narrationDuration, clipPath, 1080, 1920, effect);
      audioPaths.push(narrationPath);
    }

    tempFiles.push(clipPath);
    clipPaths.push(clipPath);
    logger.info(`[news-reaction] job ${jobId}: scene ${i + 1}/${script.scenes.length} done (${scene.type}${scene.type === 'image' ? `/${scene.imageSource}` : ''})`);
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

  return { finalPath, sceneCount: script.scenes.length };
}

module.exports = { buildNewsReactionVideo };
