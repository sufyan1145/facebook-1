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
const pollinationsService = require('./services.pollinationsService');
const pexelsService = require('./services.pexelsService');
const youtubeService = require('./services.youtubeService');
const driveService = require('./services.googleDriveService');
const facebookService = require('./services.facebookService');
const ffmpeg = require('./utils.ffmpeg');
const { notifyUploadEvent } = require('./services.notificationService');

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
    return times.includes(hhmm);
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

async function generateClip(prompt, durationSeconds, destPath, format) {
  if (env.contentPipeline.clipMode === 'image_kenburns') {
    return generateClipFromImage(prompt, durationSeconds, destPath, format);
  }
  if (env.contentPipeline.clipMode === 'hybrid') {
    try {
      return await generateClipFromStock(prompt, durationSeconds, destPath, format);
    } catch (err) {
      logger.info(`[content-pipeline] no stock footage match for scene ("${err.message}"), falling back to AI image for this scene`);
      return generateClipFromImage(prompt, durationSeconds, destPath, format);
    }
  }
  if (env.contentPipeline.clipMode === 'stock_video') {
    return generateClipFromStock(prompt, durationSeconds, destPath, format);
  }
  if (env.contentPipeline.clipMode === 'veo') {
    return generateClipFromVeo(prompt, durationSeconds, destPath, format);
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
async function generateClipFromImage(rawPrompt, durationSeconds, destPath, format) {
  const imagePath = destPath.replace(/\.mp4$/, '.png');
  // Boost every image's visual quality consistently, regardless of what the
  // script prompt already included and regardless of which image provider is used.
  const prompt = `${rawPrompt}, professional cinematography, photorealistic, highly detailed, dramatic lighting, sharp focus, 8k quality`;

  if (env.contentPipeline.imageProvider === 'gemini') {
    await geminiService.generateImage(prompt, imagePath);
  } else if (env.contentPipeline.imageProvider === 'pollinations') {
    await pollinationsService.generateImage(prompt, imagePath, format.width, format.height);
  } else {
    const taskId = await kieVideoService.createImageTask({ prompt, aspectRatio: format.aspectRatio });
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

  await ffmpeg.imageToKenBurnsClip(imagePath, durationSeconds, destPath, format.width, format.height);
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

async function runPipeline(schedule) {
  const run = await ContentScheduleRun.create(schedule.user_id, schedule.id);
  const tempFiles = [];
  let stage = 'init';

  try {
    stage = 'writing_script';
    await ContentScheduleRun.setStatus(run.id, 'writing_script');
    // Keep scene count manageable even for long-form videos (10 min at a fixed
    // 10s/scene would mean 60 scenes - too many for one Gemini script call and
    // too many stock-footage searches). Aim for a reasonable scene count and
    // scale each scene's length up for longer target durations instead.
    const desiredSceneCount = Math.min(20, Math.max(3, Math.round(schedule.target_duration_seconds / env.contentPipeline.clipSeconds)));
    const sceneSeconds = schedule.target_duration_seconds / desiredSceneCount;
    const sceneCount = desiredSceneCount;
    const script = await geminiService.writeScript(schedule.keyword, { sceneCount, sceneSeconds, language: schedule.language });
    await ContentScheduleRun.setStatus(run.id, 'writing_script', { topic: script.topic });
    logger.info(`[content-pipeline] script ready for "${schedule.keyword}": ${script.topic} (${script.scenes.length} scenes)`);

    stage = 'generating_voiceover';
    await ContentScheduleRun.setStatus(run.id, 'generating_voiceover');
    const fullNarration = script.scenes.map((s) => s.narration).join(' ');
    const voiceoverPath = path.join(env.upload.tempDir, `${run.id}_voice.mp3`);
    await googleTtsService.synthesizeToFile(fullNarration, voiceoverPath, schedule.voice_name);
    tempFiles.push(voiceoverPath);

    // The actual spoken audio rarely matches our word-count estimate exactly.
    // Measure it and size the video clips to that real duration so the video
    // covers the full voiceover instead of cutting off early or running long.
    const actualVoiceoverSeconds = await ffmpeg.getMediaDuration(voiceoverPath);
    const actualSceneSeconds = actualVoiceoverSeconds / script.scenes.length;
    logger.info(`[content-pipeline] voiceover duration: ${actualVoiceoverSeconds.toFixed(1)}s (estimated ${schedule.target_duration_seconds}s) -> ${actualSceneSeconds.toFixed(1)}s/scene`);

    stage = 'generating_clips';
    await ContentScheduleRun.setStatus(run.id, 'generating_clips');
    const format = getVideoFormat(schedule.youtube_video_type);
    const clipPaths = [];
    for (let i = 0; i < script.scenes.length; i++) {
      const clipPath = path.join(env.upload.tempDir, `${run.id}_clip${i}.mp4`);
      await generateClip(script.scenes[i].visual_prompt, actualSceneSeconds, clipPath, format);
      clipPaths.push(clipPath);
      tempFiles.push(clipPath);
    }

    stage = 'stitching';
    await ContentScheduleRun.setStatus(run.id, 'stitching');
    const stitchedPath = path.join(env.upload.tempDir, `${run.id}_stitched.mp4`);
    await ffmpeg.concatClips(clipPaths, stitchedPath);
    tempFiles.push(stitchedPath);

    const finalPath = path.join(env.upload.tempDir, `${run.id}_final.mp4`);
    await ffmpeg.mergeAudioVideo(stitchedPath, voiceoverPath, finalPath);
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
      } catch (ytErr) {
        await Log.record(schedule.user_id, 'YouTube Upload Failed', { keyword: schedule.keyword, error: ytErr.message }, 'error');
        logger.error(`[content-pipeline] YouTube upload failed for schedule ${schedule.id}: ${ytErr.message}`);
      }
    }
  } catch (err) {
    const message = `[${stage}] ${err.message}`;
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
  cron.schedule(env.contentPipeline.checkCron, async () => {
    if (running) return; // a pipeline run can take several minutes; don't overlap ticks
    running = true;
    try {
      const schedules = await ContentSchedule.listActiveDue();
      for (const schedule of schedules) {
        try {
          if (isDueNow(schedule)) {
            await runPipeline(schedule); // sequential on purpose: keeps Kie.ai/API usage predictable
          }
        } catch (err) {
          logger.error(`Content pipeline worker error for schedule ${schedule.id} (keyword: "${schedule.keyword}"): ${err.message}`);
        }
      }
    } catch (err) {
      logger.error(`Content pipeline worker error: ${err.message}`);
    } finally {
      running = false;
    }
  });
  logger.info(`Content pipeline worker started with cron: ${env.contentPipeline.checkCron}`);
}

module.exports = { startContentPipelineWorker };
