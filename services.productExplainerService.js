/**
 * Product Explainer builder for the Video Editor - a SEPARATE feature from
 * News Reaction (services.newsReactionService.js). Does not touch or import
 * anything from that file; the two are independent and can be extended
 * separately.
 *
 * Given a YouTube product video, builds a real-footage, ad-style explainer:
 *  1. Narration comes from the user's OWN supplied script when given (the
 *     most reliable way to guarantee real information) - otherwise a script
 *     is generated, grounded only in the source video's own title/description
 *     (real human-written content), never inventing specs/prices.
 *  2. Narration lines are grouped (config.env.js productExplainer.linesPerSearchGroup)
 *     and each group gets ONE YouTube search query capturing its shared
 *     visual theme - keeping YouTube Data API usage far under its free daily
 *     quota (100 units per search, ~100 free searches/day) instead of
 *     spending one search per line.
 *  3. For each group, 1-2 candidate videos are searched, downloaded, and a
 *     real segment is pulled from them for each line in that group (a
 *     proportional/heuristic point in the middle portion of the candidate -
 *     there's no per-frame product-detection step, so this is a best-effort
 *     match, not a guaranteed exact moment).
 *  4. Each beat's narration gets a short synthetic "whoosh" transition SFX
 *     at its start (self-contained, no external sound library needed).
 *
 * IMPORTANT: unlike News Reaction (which reuses ONE source video, reducing
 * repost risk), this feature downloads and recombines footage from MULTIPLE
 * OTHER creators' videos into what functions as an ad/showcase for a
 * product - a meaningfully higher copyright/platform-policy exposure than
 * single-source commentary. This was a deliberate, informed choice made
 * with the user; it does not make reuse of that footage legal on its own.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./utils.logger');
const env = require('./config.env');
const vertexAiService = require('./services.vertexAiService');
const youtubeSearchService = require('./services.youtubeSearchService');
const videoDownloadService = require('./services.videoDownloadService');
const ffmpeg = require('./utils.ffmpeg');

const SECONDS_PER_LINE = 4.5; // rough target used only to size the AI-generated script's line count

function resolveLines(customScript, lineCount) {
  if (customScript && customScript.trim()) {
    const lines = customScript
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length) {
      logger.info(`[product-explainer] using ${lines.length} user-supplied script lines (real info, no AI generation)`);
      return lines;
    }
  }
  return null; // signals "generate one"
}

/**
 * Picks a real-footage segment from a candidate video for one beat. No
 * per-frame product detection - takes a point within the middle 60% of the
 * candidate (skipping likely intros/outros), spread across however many
 * lines in the group share this same candidate pool so consecutive beats
 * don't all reuse the exact same moment.
 */
function pickHeuristicTimestamp(candidateDuration, beatIndexInGroup, beatsInGroup) {
  const usableStart = candidateDuration * 0.2;
  const usableSpan = candidateDuration * 0.6;
  const fraction = beatsInGroup > 1 ? beatIndexInGroup / (beatsInGroup - 1) : 0.5;
  return usableStart + usableSpan * fraction;
}

async function synthesizeNarration(text, destPath, voiceName) {
  // This feature always uses Vertex (higher rate limits needed given the
  // much larger number of beats than News Reaction) - see the conversation
  // decision to route Product Explainer through Vertex specifically.
  return vertexAiService.synthesizeSpeech(text, destPath, voiceName);
}

/**
 * @param {string} sourcePath - downloaded source product video (mp4)
 * @param {string} tempDir - scratch directory
 * @param {string} jobId - namespaces temp filenames
 * @param {object} opts - { title, description, customScript, voiceName, narrationLanguage, targetMinutes, orientation }
 */
async function buildProductExplainerVideo(sourcePath, tempDir, jobId, {
  title, description, customScript, voiceName, narrationLanguage, targetMinutes = 12, orientation = 'portrait',
} = {}) {
  const { width, height } = orientation === 'landscape' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };

  const targetLineCount = Math.max(1, Math.round((targetMinutes * 60) / SECONDS_PER_LINE));
  let lines = resolveLines(customScript, targetLineCount);
  if (!lines) {
    logger.info(`[product-explainer] job ${jobId}: no custom script given, generating ~${targetLineCount} lines from source title/description`);
    const result = await vertexAiService.generateProductExplainerScript(title, description, targetLineCount, { narrationLanguage });
    lines = result.lines;
  }
  logger.info(`[product-explainer] job ${jobId}: ${lines.length} narration lines total`);

  const groupSize = env.productExplainer.linesPerSearchGroup;
  const searchQueries = await vertexAiService.generateVisualSearchQueries(title || 'this product', lines, groupSize);

  // One shared "whoosh" SFX file, reused for every beat - no need to
  // regenerate per line.
  const sfxPath = path.join(tempDir, `${jobId}_whoosh.mp3`);
  await ffmpeg.generateWhooshSfx(sfxPath);

  const clipPaths = [];
  const audioPaths = [];
  const tempFiles = [sfxPath];
  const groupCandidatesCache = new Map(); // query -> [{path, duration}]

  for (let i = 0; i < lines.length; i++) {
    const groupIndex = Math.floor(i / groupSize);
    const beatIndexInGroup = i % groupSize;
    const beatsInThisGroup = Math.min(groupSize, lines.length - groupIndex * groupSize);
    const query = searchQueries[i];

    // Download this group's candidate pool once, reuse for every line in the group.
    if (!groupCandidatesCache.has(query)) {
      const pool = [];
      try {
        const results = await youtubeSearchService.searchVideos(query, env.productExplainer.candidatesPerGroup);
        for (let c = 0; c < results.length; c++) {
          try {
            const candidatePath = path.join(tempDir, `${jobId}_candidate_g${groupIndex}_${c}.mp4`);
            await videoDownloadService.downloadVideo(results[c].url, candidatePath);
            const duration = await ffmpeg.getMediaDuration(candidatePath);
            pool.push({ path: candidatePath, duration });
            tempFiles.push(candidatePath);
          } catch (dlErr) {
            logger.info(`[product-explainer] candidate download failed for "${query}" (${results[c]?.url}): ${dlErr.message}`);
          }
        }
      } catch (searchErr) {
        logger.error(`[product-explainer] YouTube search failed for "${query}": ${searchErr.message}`);
      }
      groupCandidatesCache.set(query, pool);
    }
    const pool = groupCandidatesCache.get(query);

    // Narration first - its actual spoken duration drives this beat's visual length.
    const narrationPath = path.join(tempDir, `${jobId}_narration_${i}.mp3`);
    await synthesizeNarration(lines[i], narrationPath, voiceName);
    tempFiles.push(narrationPath);
    const narrationDuration = await ffmpeg.getMediaDuration(narrationPath);

    const beatAudioPath = path.join(tempDir, `${jobId}_beat_audio_${i}.mp3`);
    await ffmpeg.mixNarrationWithSfx(narrationPath, sfxPath, beatAudioPath);
    tempFiles.push(beatAudioPath);
    audioPaths.push(beatAudioPath);

    const clipPath = path.join(tempDir, `${jobId}_beat_visual_${i}.mp4`);
    if (pool.length > 0) {
      const candidate = pool[i % pool.length];
      const startTime = pickHeuristicTimestamp(candidate.duration, beatIndexInGroup, beatsInThisGroup);
      const safeStart = Math.min(startTime, Math.max(0, candidate.duration - narrationDuration - 0.5));
      await ffmpeg.trimSilentClip(candidate.path, safeStart, narrationDuration, clipPath, width, height);
    } else {
      // No usable candidate found for this beat (search/downloads all
      // failed) - fall back to a segment of the SOURCE video itself rather
      // than failing the whole job.
      logger.info(`[product-explainer] job ${jobId}: no real footage found for beat ${i + 1} ("${query}"), using a moment from the source video instead`);
      const sourceDuration = await ffmpeg.getMediaDuration(sourcePath);
      const fallbackStart = Math.min((i / lines.length) * sourceDuration, Math.max(0, sourceDuration - narrationDuration - 0.5));
      await ffmpeg.trimSilentClip(sourcePath, fallbackStart, narrationDuration, clipPath, width, height);
    }
    tempFiles.push(clipPath);
    clipPaths.push(clipPath);

    logger.info(`[product-explainer] job ${jobId}: beat ${i + 1}/${lines.length} done`);
  }

  const stitchedVideoPath = path.join(tempDir, `${jobId}_pe_video.mp4`);
  await ffmpeg.concatClips(clipPaths, stitchedVideoPath);
  tempFiles.push(stitchedVideoPath);

  const stitchedAudioPath = path.join(tempDir, `${jobId}_pe_audio.mp3`);
  await ffmpeg.concatAudio(audioPaths, stitchedAudioPath);
  tempFiles.push(stitchedAudioPath);

  const finalPath = path.join(tempDir, `${jobId}_pe_final.mp4`);
  await ffmpeg.mergeAudioVideo(stitchedVideoPath, stitchedAudioPath, finalPath);

  tempFiles.forEach((f) => { if (f !== finalPath) fs.unlink(f, () => {}); });

  return { finalPath, lineCount: lines.length };
}

module.exports = { buildProductExplainerVideo };
