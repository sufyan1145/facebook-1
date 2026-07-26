/**
 * Worker 7: Fully-Automated Content Pipeline
 * On schedule: keyword -> AI script -> AI voiceover -> AI video clips ->
 * stitched together -> saved to Drive -> posted to the Facebook Page.
 */
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const env = require('./config.env');
const logger = require('./utils.logger');
const ContentSchedule = require('./models.ContentSchedule');
const ContentScheduleRun = require('./models.ContentScheduleRun');
const Page = require('./models.Page');
const Log = require('./models.Log');
const geminiService = require('./services.geminiService');
const googleTtsService = require('./services.googleTtsService');
const kieVideoService = require('./services.kieVideoService');
const grokVideoService = require('./services.grokVideoService');
const vertexAiService = require('./services.vertexAiService');
const pollinationsService = require('./services.pollinationsService');
const pexelsService = require('./services.pexelsService');
const youtubeService = require('./services.youtubeService');
const driveService = require('./services.googleDriveService');
const facebookService = require('./services.facebookService');
const ffmpeg = require('./utils.ffmpeg');
const { notifyUploadEvent } = require('./services.notificationService');
const credits = require('./utils.credits');

const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function nowInTimezone(timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = fmt.formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return { hhmm: `${get('hour')}:${get('minute')}`, weekday: get('weekday'), dateKey: `${get('year')}-${get('month')}-${get('day')}` };
}

function dateKeyInTimezone(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = fmt.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function shouldRunToday(schedule, weekday) {
  if (schedule.repeat_type === 'daily') return true;
  if (schedule.repeat_type === 'weekly') return weekday === 'Mon';
  if (schedule.repeat_type === 'monthly') return new Date().getDate() === 1;
  if (schedule.repeat_type === 'specific_days') return (schedule.specific_days || []).includes(WEEKDAY_MAP[weekday]);
  return false;
}

function isDueNow(schedule) {
  if (schedule.repeat_type === 'interval_hours') {
    const intervalMs = (schedule.interval_hours || 1) * 60 * 60 * 1000;
    if (!schedule.last_run_at) return true;
    return Date.now() - new Date(schedule.last_run_at).getTime() >= intervalMs;
  }

  const { hhmm, weekday, dateKey } = nowInTimezone(schedule.timezone);

  if (schedule.repeat_type === 'multiple_times') {
    const times = Array.isArray(schedule.times) ? schedule.times : [];
    const [curH, curM] = hhmm.split(':').map(Number);
    const curMinutes = curH * 60 + curM;
    const GRACE_MINUTES = 15;
    const withinAnySlot = times.some((t) => {
      const [th, tm] = t.split(':').map(Number);
      const targetMinutes = th * 60 + tm;
      return curMinutes >= targetMinutes && curMinutes <= targetMinutes + GRACE_MINUTES;
    });
    if (!withinAnySlot) return false;
    if (!schedule.last_run_at) return true;
    // Don't re-fire repeatedly for the same slot while still inside its grace window.
    const minutesSinceLastRun = (Date.now() - new Date(schedule.last_run_at).getTime()) / 60000;
    return minutesSinceLastRun >= GRACE_MINUTES;
  }

  if (!shouldRunToday(schedule, weekday)) return false;
  const [targetH, targetM] = schedule.upload_time.split(':').map(Number);
  const [curH, curM] = hhmm.split(':').map(Number);
  const targetMinutes = targetH * 60 + targetM;
  const curMinutes = curH * 60 + curM;
  const GRACE_MINUTES = 15;
  if (curMinutes < targetMinutes || curMinutes > targetMinutes + GRACE_MINUTES) return false;

  const lastRunDateKey = schedule.last_run_at ? dateKeyInTimezone(new Date(schedule.last_run_at), schedule.timezone) : null;
  return lastRunDateKey !== dateKey;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateClip(prompt, durationSeconds, destPath, format, sceneIndex = 0) {
  if (env.contentPipeline.clipMode === 'veo_intro_kenburns') {
    if (sceneIndex < env.contentPipeline.veoIntroScenes) {
      // First N scenes: short Veo3 render (cheap/fast), then normalized/looped
      // to this scene's real voiceover length so timing stays exact. If Veo3
      // keeps failing (e.g. a persistent Google-side error) after its own
      // retries, fall back to an AI image for just this scene instead of
      // failing the whole video.
      try {
        return await generateClipFromVertexVeo(prompt, durationSeconds, destPath, format, env.contentPipeline.veoIntroSeconds);
      } catch (err) {
        logger.info(`[content-pipeline] Veo3 intro scene ${sceneIndex} failed ("${err.message}"), falling back to AI image for this scene`);
        return generateClipFromImage(prompt, durationSeconds, destPath, format, sceneIndex);
      }
    }
    return generateClipFromImage(prompt, durationSeconds, destPath, format, sceneIndex);
  }
  if (env.contentPipeline.clipMode === 'image_kenburns') {
    return generateClipFromImage(prompt, durationSeconds, destPath, format, sceneIndex);
  }
  if (env.contentPipeline.clipMode === 'hybrid') {
    try {
      return await generateClipFromStock(prompt, durationSeconds, destPath, format);
    } catch (err) {
      logger.info(`[content-pipeline] no stock footage match for scene ("${err.message}"), falling back to AI image for this scene`);
      return generateClipFromImage(prompt, durationSeconds, destPath, format, sceneIndex);
    }
  }
  if (env.contentPipeline.clipMode === 'stock_video') {
    return generateClipFromStock(prompt, durationSeconds, destPath, format);
  }
  if (env.contentPipeline.clipMode === 'veo') {
    return generateClipFromVeo(prompt, durationSeconds, destPath, format);
  }
  if (env.contentPipeline.clipMode === 'grok') {
    return generateClipFromGrok(prompt, durationSeconds, destPath, format);
  }
  if (env.contentPipeline.clipMode === 'vertex_veo') {
    return generateClipFromVertexVeo(prompt, durationSeconds, destPath, format);
  }
  const taskId = await kieVideoService.createVideoTask({ prompt, duration: durationSeconds, aspectRatio: format.aspectRatio });
  const maxAttempts = 60; // up to ~10 minutes per clip
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(10000);
    const status = await kieVideoService.getTaskStatus(taskId);
    const state = status.state || status.status;
    if (state === 'success') {
      const url = kieVideoService.extractResultUrl(status);
      if (!url) throw new Error('Clip generated but no result URL was returned');
      await kieVideoService.downloadResult(url, destPath);
      return destPath;
    }
    if (state === 'fail') {
      throw new Error(status.failMsg || status.failReason || 'Clip generation failed');
    }
  }
  throw new Error('Clip generation timed out');
}

// Cheaper path: one AI-generated still image per scene, animated with a zoom/pan
// (Ken Burns) effect instead of a full AI text-to-video render.
// Generates a single still image via whichever provider is configured
// (kie/gemini/pollinations). Reused for both Ken Burns clips and thumbnails.
async function generateStandaloneImage(prompt, imagePath, width, height, aspectRatio) {
  if (env.contentPipeline.imageProvider === 'gemini') {
    await geminiService.generateImage(prompt, imagePath);
  } else if (env.contentPipeline.imageProvider === 'vertex') {
    await vertexAiService.generateImage(prompt, imagePath);
  } else if (env.contentPipeline.imageProvider === 'pollinations') {
    await pollinationsService.generateImage(prompt, imagePath, width, height);
  } else {
    const taskId = await kieVideoService.createImageTask({ prompt, aspectRatio });
    const maxAttempts = 30; // images are much faster than video, ~5 min ceiling
    let done = false;
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(5000);
      const status = await kieVideoService.getTaskStatus(taskId);
      const state = status.state || status.status;
      if (state === 'success') {
        const url = kieVideoService.extractResultUrl(status);
        if (!url) throw new Error('Image generated but no result URL was returned');
        await kieVideoService.downloadResult(url, imagePath);
        done = true;
        break;
      }
      if (state === 'fail') {
        throw new Error(status.failMsg || status.failReason || 'Image generation failed');
      }
    }
    if (!done) throw new Error('Image generation timed out');
  }
  return imagePath;
}

// Cycled across scenes (by scene index) so consecutive clips don't repeat the
// same motion - gives the video visual variety instead of one repeated zoom.
const KEN_BURNS_EFFECTS = ['zoom_in', 'pan_left', 'popup', 'zoom_out', 'pan_right', 'pan_up', 'pan_down'];

async function generateClipFromImage(rawPrompt, durationSeconds, destPath, format, sceneIndex = 0) {
  const imagePath = destPath.replace(/\.mp4$/, '.png');
  // Boost every image's visual quality consistently, regardless of what the
  // script prompt already included and regardless of which image provider is used.
  const prompt = `${rawPrompt}, professional cinematography, photorealistic, highly detailed, dramatic lighting, sharp focus, 8k quality`;
  await generateStandaloneImage(prompt, imagePath, format.width, format.height, format.aspectRatio);

  const effect = KEN_BURNS_EFFECTS[sceneIndex % KEN_BURNS_EFFECTS.length];
  await ffmpeg.imageToKenBurnsClip(imagePath, durationSeconds, destPath, format.width, format.height, effect);
  fs.unlinkSync(imagePath);
  return destPath;
}

// Free path: real stock footage from Pexels instead of any AI generation.
// Uses a short keyword query (first few words of the scene's visual prompt)
// since stock search engines work better with simple terms than full sentences.
async function generateClipFromStock(prompt, durationSeconds, destPath, format) {
  const query = prompt.split(/\s+/).slice(0, 6).join(' ');
  const rawPath = destPath.replace(/\.mp4$/, '_raw.mp4');

  const url = await pexelsService.searchVideoUrl(query, format.orientation);
  await pexelsService.downloadVideo(url, rawPath);
  await ffmpeg.normalizeClip(rawPath, durationSeconds, destPath, format.width, format.height);
  fs.unlinkSync(rawPath);
  return destPath;
}

// Shorts = vertical (9:16), Long-form = landscape (16:9). Everything downstream
// (AI video/image generation, stock footage search, ffmpeg output size) follows this.
function getVideoFormat(youtubeVideoType) {
  if (youtubeVideoType === 'long') {
    return { aspectRatio: '16:9', orientation: 'landscape', width: 1920, height: 1080 };
  }
  return { aspectRatio: '9:16', orientation: 'portrait', width: 1080, height: 1920 };
}

function assTimestamp(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds - Math.floor(seconds)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// Builds a bold, high-contrast animated-caption (.ass) file for the WHOLE video in
// one pass, in the short-form "2-3 words on screen at a time" style. Each scene gets
// an even split of its own narration across its own time window (cumulative offset
// from all prior scenes) - not perfectly word-accurate (no per-word speech
// timestamps are available from the TTS), but close enough to look natural.
function buildFullCaptionAss(scenes, sceneDurations, format) {
  const fontSize = format.orientation === 'landscape' ? 64 : 72;
  const marginV = format.orientation === 'landscape' ? 80 : 220;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${format.width}
PlayResY: ${format.height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,DejaVu Sans,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,2,2,40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const wordsPerChunk = 3;
  const events = [];
  let sceneStart = 0;
  scenes.forEach((scene, sceneIndex) => {
    const sceneSeconds = sceneDurations[sceneIndex];
    const words = scene.narration.trim().split(/\s+/).filter(Boolean);
    const chunks = [];
    for (let i = 0; i < words.length; i += wordsPerChunk) {
      chunks.push(words.slice(i, i + wordsPerChunk).join(' '));
    }
    if (!chunks.length) chunks.push('');
    const perChunkSeconds = sceneSeconds / chunks.length;

    chunks.forEach((chunk, i) => {
      const start = assTimestamp(sceneStart + i * perChunkSeconds);
      const end = assTimestamp(sceneStart + (i + 1) * perChunkSeconds);
      const escaped = chunk.replace(/[{}]/g, '').toUpperCase();
      events.push(`Dialogue: 0,${start},${end},Caption,,0,0,0,,{\\fad(80,80)}${escaped}`);
    });
    sceneStart += sceneSeconds;
  });

  return header + events.join('\n') + '\n';
}

// Google Veo3 (via Kie.ai) - highest cinematic quality and the strongest prompt
// adherence of the available options, at higher cost. Veo always renders a fixed
// ~8-second clip regardless of requested length, so we trim/loop it afterwards
// to match this scene's actual duration (keeping it in sync with the voiceover).
async function generateClipFromVeo(prompt, durationSeconds, destPath, format) {
  const taskId = await kieVideoService.createVeoVideoTask({ prompt, aspectRatio: format.aspectRatio });
  const rawPath = destPath.replace(/\.mp4$/, '_raw.mp4');
  const maxAttempts = 60; // Veo can take several minutes per clip
  let done = false;
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(10000);
    const status = await kieVideoService.getVeoTaskStatus(taskId);
    if (status.successFlag === 1) {
      const url = kieVideoService.extractVeoResultUrl(status);
      if (!url) throw new Error('Veo clip generated but no result URL was returned');
      await kieVideoService.downloadResult(url, rawPath);
      done = true;
      break;
    }
    if (status.successFlag && status.successFlag !== 1) {
      throw new Error(status.errorMessage || 'Veo clip generation failed');
    }
  }
  if (!done) throw new Error('Veo clip generation timed out');

  await ffmpeg.normalizeClip(rawPath, durationSeconds, destPath, format.width, format.height);
  fs.unlinkSync(rawPath);
  return destPath;
}

// xAI Grok Imagine - cinematic text-to-video with a $175/month free-credit program.
// Unlike Veo, Grok accepts an explicit duration (capped at 15s), so we only need
// ffmpeg normalization as a safety net for scenes longer than that cap.
async function generateClipFromGrok(prompt, durationSeconds, destPath, format) {
  const requestId = await grokVideoService.createVideoTask({ prompt, duration: durationSeconds, aspectRatio: format.aspectRatio });
  const rawPath = destPath.replace(/\.mp4$/, '_raw.mp4');
  const maxAttempts = 40; // Grok clips are usually faster than Veo, but allow room
  let done = false;
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(8000);
    const status = await grokVideoService.getTaskStatus(requestId);
    if (status.status === 'done') {
      const url = grokVideoService.extractResultUrl(status);
      if (!url) throw new Error('Grok clip generated but no result URL was returned');
      await grokVideoService.downloadResult(url, rawPath);
      done = true;
      break;
    }
    if (status.status === 'failed' || status.status === 'error') {
      throw new Error(status.error || 'Grok clip generation failed');
    }
  }
  if (!done) throw new Error('Grok clip generation timed out');

  await ffmpeg.normalizeClip(rawPath, durationSeconds, destPath, format.width, format.height);
  fs.unlinkSync(rawPath);
  return destPath;
}

// Google Veo3 via Vertex AI (own billing account/credit, separate from the
// Kie.ai-based 'veo' mode). Veo3 always renders a fixed ~8-second clip, so we
// trim/loop it afterwards to match this scene's actual duration.
async function generateClipFromVertexVeo(prompt, durationSeconds, destPath, format, veoRequestSeconds) {
  const requestDuration = veoRequestSeconds || durationSeconds;
  const rawPath = destPath.replace(/\.mp4$/, '_raw.mp4');
  const maxRetries = 2; // Vertex occasionally returns a transient "Internal error" on the operation - worth a couple of fresh attempts
  const maxAttempts = 60; // Veo can take several minutes per clip

  for (let retry = 0; retry <= maxRetries; retry++) {
    const operationName = await vertexAiService.createVeoVideoTask({ prompt, duration: requestDuration, aspectRatio: format.aspectRatio });
    let done = false;
    let bytes = null;
    let operationError = null;

    for (let i = 0; i < maxAttempts; i++) {
      await sleep(10000);
      const status = await vertexAiService.getVeoOperationStatus(operationName);
      if (status.done) {
        if (status.error) {
          operationError = status.error;
        } else {
          bytes = vertexAiService.extractVeoResultBytes(status);
        }
        done = true;
        break;
      }
    }

    if (!done) throw new Error('Veo (Vertex) clip generation timed out');

    if (operationError) {
      logger.error(`[vertex] veo operation ${operationName} finished with an error (attempt ${retry + 1}/${maxRetries + 1}): ${JSON.stringify(operationError)}`);
      if (retry < maxRetries) {
        await sleep(5000);
        continue; // resubmit a fresh Veo request
      }
      throw new Error(`Veo (Vertex) generation failed after ${maxRetries + 1} attempts: ${operationError.message || JSON.stringify(operationError)}`);
    }

    if (!bytes) throw new Error('Veo (Vertex) clip generated but no video bytes were returned and no error was reported');

    fs.writeFileSync(rawPath, Buffer.from(bytes, 'base64'));
    await ffmpeg.normalizeClip(rawPath, durationSeconds, destPath, format.width, format.height);
    fs.unlinkSync(rawPath);
    return destPath;
  }
}

async function runPipeline(schedule) {
  const run = await ContentScheduleRun.create(schedule.user_id, schedule.id);
  const tempFiles = [];
  let stage = 'init';
  let chargedSeconds = 0;

  try {
    stage = 'checking_credits';
    await ContentScheduleRun.setStatus(run.id, 'checking_credits');
    await credits.charge(schedule.user_id, schedule.target_duration_seconds, 'pipeline_video', run.id);
    chargedSeconds = schedule.target_duration_seconds;

    stage = 'writing_script';
    await ContentScheduleRun.setStatus(run.id, 'writing_script');
    let script;
    if (schedule.custom_script && schedule.custom_script.trim()) {
      // User supplied their own narration - use it word-for-word. We only ask
      // Gemini to split it into scenes and describe an image for each one.
      script = await geminiService.writeVisualPromptsForScript(schedule.custom_script, {
        clipSeconds: env.contentPipeline.clipSeconds,
        masterPrompt: schedule.master_prompt,
        contentFormat: schedule.content_format,
      });
    } else {
      // Keep scene count manageable even for long-form videos (10 min at a fixed
      // 10s/scene would mean 60 scenes - too many for one Gemini script call and
      // too many stock-footage searches). Aim for a reasonable scene count and
      // scale each scene's length up for longer target durations instead.
      const desiredSceneCount = Math.min(20, Math.max(3, Math.round(schedule.target_duration_seconds / env.contentPipeline.clipSeconds)));
      const sceneSeconds = schedule.target_duration_seconds / desiredSceneCount;
      const sceneCount = desiredSceneCount;
      const scriptParams = { sceneCount, sceneSeconds, language: schedule.language, masterPrompt: schedule.master_prompt, contentFormat: schedule.content_format };
      script = env.contentPipeline.scriptProvider === 'vertex'
        ? await vertexAiService.writeScript(schedule.keyword, scriptParams)
        : await geminiService.writeScript(schedule.keyword, scriptParams);
    }
    await ContentScheduleRun.setStatus(run.id, 'writing_script', { topic: script.topic });
    logger.info(`[content-pipeline] script ready for "${schedule.keyword}": ${script.topic} (${script.scenes.length} scenes)`);

    stage = 'generating_voiceover';
    await ContentScheduleRun.setStatus(run.id, 'generating_voiceover');
    // Synthesize each scene's narration SEPARATELY (instead of one TTS call for
    // the whole script) so we know each scene's exact spoken duration - not an
    // even split. This is what keeps the visuals lined up with the voiceover:
    // scene N's clip is exactly as long as scene N's own narration audio.
    const sceneAudioPaths = [];
    const sceneDurations = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const sceneAudioPath = path.join(env.upload.tempDir, `${run.id}_voice${i}.mp3`);
      if (env.contentPipeline.ttsProvider === 'vertex') {
        await vertexAiService.synthesizeSpeech(script.scenes[i].narration, sceneAudioPath, schedule.voice_name);
      } else {
        await googleTtsService.synthesizeToFile(script.scenes[i].narration, sceneAudioPath, schedule.voice_name);
      }
      const sceneDuration = await ffmpeg.getMediaDuration(sceneAudioPath);
      sceneAudioPaths.push(sceneAudioPath);
      sceneDurations.push(sceneDuration);
      tempFiles.push(sceneAudioPath);
    }

    const voiceoverPath = path.join(env.upload.tempDir, `${run.id}_voice.mp3`);
    await ffmpeg.concatAudio(sceneAudioPaths, voiceoverPath);
    tempFiles.push(voiceoverPath);

    const actualVoiceoverSeconds = sceneDurations.reduce((sum, d) => sum + d, 0);
    logger.info(`[content-pipeline] voiceover duration: ${actualVoiceoverSeconds.toFixed(1)}s (estimated ${schedule.target_duration_seconds}s) across ${script.scenes.length} scenes: [${sceneDurations.map((d) => d.toFixed(1)).join(', ')}]s`);

    // The estimate charged upfront rarely matches the real spoken length exactly -
    // true up the charge (extra charge or partial refund) now that we know it.
    await credits.reconcile(schedule.user_id, chargedSeconds, actualVoiceoverSeconds, 'pipeline_video', run.id);
    chargedSeconds = actualVoiceoverSeconds;

    stage = 'generating_clips';
    await ContentScheduleRun.setStatus(run.id, 'generating_clips');
    const format = getVideoFormat(schedule.youtube_video_type);
    const clipPaths = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const clipPath = path.join(env.upload.tempDir, `${run.id}_clip${i}.mp4`);
      await generateClip(script.scenes[i].visual_prompt, sceneDurations[i], clipPath, format, i);
      clipPaths.push(clipPath);
      tempFiles.push(clipPath);
      // Small pause between scenes so back-to-back Vertex API calls (image/TTS)
      // don't burst past its per-minute quota and trigger 429s on longer videos.
      if (i < script.scenes.length - 1) await sleep(2000);
    }

    stage = 'stitching';
    await ContentScheduleRun.setStatus(run.id, 'stitching');
    const stitchedPath = path.join(env.upload.tempDir, `${run.id}_stitched.mp4`);
    await ffmpeg.concatClips(clipPaths, stitchedPath);
    tempFiles.push(stitchedPath);

    let captionedPath = stitchedPath;
    if (env.contentPipeline.captionsEnabled) {
      // One caption pass for the whole video (instead of one per clip) - much
      // faster, since each ffmpeg re-encode is the expensive part.
      const assPath = path.join(env.upload.tempDir, `${run.id}_captions.ass`);
      fs.writeFileSync(assPath, buildFullCaptionAss(script.scenes, sceneDurations, format));
      tempFiles.push(assPath);

      captionedPath = path.join(env.upload.tempDir, `${run.id}_captioned.mp4`);
      await ffmpeg.burnCaptions(stitchedPath, assPath, captionedPath);
      tempFiles.push(captionedPath);
    }

    const finalPath = path.join(env.upload.tempDir, `${run.id}_final.mp4`);
    await ffmpeg.mergeAudioVideo(captionedPath, voiceoverPath, finalPath);
    tempFiles.push(finalPath);

    stage = 'uploading_drive';
    await ContentScheduleRun.setStatus(run.id, 'uploading_drive');
    const fileName = `${script.topic.replace(/[^a-z0-9]+/gi, '_').slice(0, 60)}.mp4`;
    const uploaded = await driveService.uploadFile(schedule.user_id, schedule.drive_folder_id, finalPath, fileName);

    let fbVideoId = null;
    if (schedule.post_to_facebook !== false && schedule.page_db_id) {
      stage = 'posting_facebook';
      await ContentScheduleRun.setStatus(run.id, 'posting_facebook');
      const page = await Page.findById(schedule.user_id, schedule.page_db_id);
      fbVideoId = await facebookService.uploadVideoToPage({
        pageId: page.page_id,
        pageAccessToken: page.page_access_token,
        filePath: finalPath,
        caption: schedule.caption || script.topic,
        hashtags: schedule.hashtags,
        publishImmediately: schedule.publish_immediately,
      });
      await Log.record(schedule.user_id, 'Content Pipeline Completed', { keyword: schedule.keyword, topic: script.topic, page: schedule.page_name });
      await notifyUploadEvent(schedule.user_id, { type: 'success', videoName: fileName, pageName: schedule.page_name });
      logger.info(`[content-pipeline] completed for schedule ${schedule.id}, fb video id: ${fbVideoId}`);
    } else {
      await Log.record(schedule.user_id, 'Content Pipeline Completed', { keyword: schedule.keyword, topic: script.topic, note: 'Facebook posting skipped' });
      logger.info(`[content-pipeline] completed for schedule ${schedule.id} (Facebook posting skipped)`);
    }

    await ContentScheduleRun.markCompleted(run.id, { driveFileId: uploaded.id, fbVideoId });
    await ContentSchedule.updateLastRun(schedule.id);

    // YouTube is optional and best-effort: a failure here should NOT mark an
    // otherwise-successful run (Facebook already posted, or intentionally skipped) as failed.
    if (schedule.youtube_token_id) {
      try {
        stage = 'posting_youtube';
        await ContentScheduleRun.setStatus(run.id, 'posting_youtube');
        const tags = (schedule.hashtags || '')
          .split(/\s+/)
          .map((h) => h.replace(/^#/, '').trim())
          .filter(Boolean);
        const youtubeVideoId = await youtubeService.uploadVideo(schedule.user_id, schedule.youtube_token_id, finalPath, {
          title: script.topic,
          description: schedule.caption || script.topic,
          tags,
          videoType: schedule.youtube_video_type,
        });
        await Log.record(schedule.user_id, 'YouTube Upload Completed', { keyword: schedule.keyword, youtubeVideoId });
        logger.info(`[content-pipeline] YouTube upload succeeded for schedule ${schedule.id}, video id: ${youtubeVideoId}`);

        // Custom thumbnail is also best-effort - a failure here shouldn't affect the video upload above.
        try {
          const thumbBgPath = path.join(env.upload.tempDir, `${run.id}_thumb_bg.png`);
          const thumbPath = path.join(env.upload.tempDir, `${run.id}_thumb.jpg`);
          const thumbPrompt = `${script.topic}, dramatic, eye-catching, vibrant colors, high contrast, professional YouTube thumbnail background, cinematic, no text, no words, no logos`;
          await generateStandaloneImage(thumbPrompt, thumbBgPath, 1280, 720, '16:9');
          tempFiles.push(thumbBgPath);
          await ffmpeg.generateThumbnail(thumbBgPath, script.topic, thumbPath);
          tempFiles.push(thumbPath);
          await youtubeService.uploadThumbnail(schedule.user_id, schedule.youtube_token_id, youtubeVideoId, thumbPath);
          logger.info(`[content-pipeline] custom thumbnail set for schedule ${schedule.id}`);
        } catch (thumbErr) {
          logger.error(`[content-pipeline] thumbnail generation/upload failed for schedule ${schedule.id}: ${thumbErr.message}`);
        }
      } catch (ytErr) {
        await Log.record(schedule.user_id, 'YouTube Upload Failed', { keyword: schedule.keyword, error: ytErr.message }, 'error');
        logger.error(`[content-pipeline] YouTube upload failed for schedule ${schedule.id}: ${ytErr.message}`);
      }
    }
  } catch (err) {
    const message = `[${stage}] ${err.message}`;
    if (chargedSeconds > 0) {
      try {
        await credits.refund(schedule.user_id, chargedSeconds, run.id, 'pipeline_video');
      } catch (refundErr) {
        logger.error(`[content-pipeline] credit refund failed for schedule ${schedule.id}: ${refundErr.message}`);
      }
    }
    await ContentScheduleRun.markFailed(run.id, message);
    await ContentSchedule.updateLastRun(schedule.id); // don't retry every minute - wait for the next scheduled occurrence
    await Log.record(schedule.user_id, 'Content Pipeline Failed', { keyword: schedule.keyword, error: message }, 'error');
    logger.error(`[content-pipeline] failed for schedule ${schedule.id}: ${message}`);
  } finally {
    tempFiles.forEach(driveService.deleteTempFile);
  }
}

function startContentPipelineWorker() {
  let running = false;
  const queue = [];
  const queuedIds = new Set();

  cron.schedule(env.contentPipeline.checkCron, async () => {
    // Always check for newly-due schedules, even while a previous run is still
    // in progress - this used to be skipped entirely while `running` was true,
    // which silently dropped triggers (especially exact-time "multiple times a
    // day" slots) whenever a video was still generating from an earlier tick.
    try {
      const schedules = await ContentSchedule.listActiveDue();
      for (const schedule of schedules) {
        if (!queuedIds.has(schedule.id) && isDueNow(schedule)) {
          queue.push(schedule);
          queuedIds.add(schedule.id);
        }
      }
    } catch (err) {
      logger.error(`Content pipeline worker error: ${err.message}`);
    }

    if (running) return; // a pipeline run is already in progress; queued schedules will run once it finishes
    running = true;
    try {
      while (queue.length) {
        const schedule = queue.shift();
        try {
          await runPipeline(schedule); // sequential on purpose: keeps Kie.ai/API usage predictable
        } catch (err) {
          logger.error(`Content pipeline worker error for schedule ${schedule.id} (keyword: "${schedule.keyword}"): ${err.message}`);
        } finally {
          // Only stop tracking this schedule as "queued" once its run has
          // actually finished - removing it earlier let a still-running
          // schedule get re-detected as due and queued a second time.
          queuedIds.delete(schedule.id);
        }
      }
    } finally {
      running = false;
    }
  });
  logger.info(`Content pipeline worker started with cron: ${env.contentPipeline.checkCron}`);
}

module.exports = { startContentPipelineWorker };
