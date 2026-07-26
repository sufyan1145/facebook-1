/**
 * Worker 6: AI Video Generation Poller
 * Periodically checks in-progress Kie.ai video generation jobs; once a job is
 * done, downloads the result and saves it into the target Google Drive folder
 * so the existing schedule/upload pipeline can pick it up like any other video.
 */
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const env = require('./config.env');
const logger = require('./utils.logger');
const VideoGenJob = require('./models.VideoGenJob');
const kieVideoService = require('./services.kieVideoService');
const vertexAiService = require('./services.vertexAiService');
const driveService = require('./services.googleDriveService');
const ffmpeg = require('./utils.ffmpeg');
const credits = require('./utils.credits');
const Log = require('./models.Log');
const { notifyUploadEvent } = require('./services.notificationService');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Generates one Veo3 clip WITH native audio/voice (like Google Flow) - up to
// 8s per Veo call, retried a couple of times if Vertex returns a transient
// internal error.
async function generateVeoClipWithAudio(prompt, durationSeconds, destPath, aspectRatio) {
  const maxRetries = 2;
  const maxAttempts = 60; // Veo can take several minutes per clip

  for (let retry = 0; retry <= maxRetries; retry++) {
    const operationName = await vertexAiService.createVeoVideoTask({ prompt, duration: durationSeconds, aspectRatio, generateAudio: true });
    let done = false;
    let bytes = null;
    let operationError = null;

    for (let i = 0; i < maxAttempts; i++) {
      await sleep(10000);
      const status = await vertexAiService.getVeoOperationStatus(operationName);
      if (status.done) {
        if (status.error) operationError = status.error;
        else bytes = vertexAiService.extractVeoResultBytes(status);
        done = true;
        break;
      }
    }
    if (!done) throw new Error('Veo3 clip generation timed out');

    if (operationError) {
      logger.error(`[video-gen-vertex] Veo operation error (attempt ${retry + 1}/${maxRetries + 1}): ${JSON.stringify(operationError)}`);
      if (retry < maxRetries) {
        await sleep(5000);
        continue;
      }
      throw new Error(operationError.message || 'Veo3 generation failed');
    }

    if (!bytes) throw new Error('Veo3 clip generated but no video bytes were returned');
    fs.writeFileSync(destPath, Buffer.from(bytes, 'base64'));
    return destPath;
  }
}

// Runs a full Video Generator job through Vertex Veo3 with native audio -
// chunks requests longer than 8s into multiple Veo calls and stitches them
// together, charging credits (1.5/sec) up front and refunding in full on failure.
async function generateWithVertex(job) {
  const requestedSeconds = job.requested_duration_seconds || Number(job.duration) || 8;
  const tempFiles = [];
  try {
    await credits.charge(job.user_id, requestedSeconds, 'video_generator', job.id);
    await VideoGenJob.setCreditsCharged(job.id, credits.costForSeconds(requestedSeconds));
    await VideoGenJob.setStatus(job.id, 'generating');

    const chunkCount = Math.max(1, Math.ceil(requestedSeconds / 8));
    const chunkSeconds = requestedSeconds / chunkCount;
    const clipPaths = [];
    for (let i = 0; i < chunkCount; i++) {
      const clipPath = path.join(env.upload.tempDir, `${job.id}_clip${i}.mp4`);
      await generateVeoClipWithAudio(job.topic, chunkSeconds, clipPath, job.aspect_ratio);
      clipPaths.push(clipPath);
      tempFiles.push(clipPath);
    }

    let finalPath = clipPaths[0];
    if (clipPaths.length > 1) {
      finalPath = path.join(env.upload.tempDir, `${job.id}_final.mp4`);
      await ffmpeg.concatClips(clipPaths, finalPath);
      tempFiles.push(finalPath);
    }

    await VideoGenJob.setStatus(job.id, 'downloading');
    const fileName = `${(job.topic || 'video').replace(/[^a-z0-9]+/gi, '_').slice(0, 60)}.mp4`;
    const uploaded = await driveService.uploadFile(job.user_id, job.drive_folder_id, finalPath, fileName);
    await VideoGenJob.markCompleted(job.id, { driveFileId: uploaded.id, driveFileName: uploaded.name });
    await Log.record(job.user_id, 'Video Generated', { topic: job.topic, driveFileName: uploaded.name });
    await notifyUploadEvent(job.user_id, { type: 'success', videoName: uploaded.name, pageName: 'Video Generation' });
    logger.info(`[video-gen-vertex] completed job ${job.id}`);
  } catch (err) {
    logger.error(`[video-gen-vertex] failed for job ${job.id}: ${err.message}`);
    try {
      await credits.refund(job.user_id, requestedSeconds, job.id);
    } catch (refundErr) {
      logger.error(`[video-gen-vertex] refund failed for job ${job.id}: ${refundErr.message}`);
    }
    await VideoGenJob.markFailed(job.id, err.message);
    await Log.record(job.user_id, 'Video Generation Failed', { topic: job.topic, error: err.message }, 'error');
  } finally {
    tempFiles.forEach(driveService.deleteTempFile);
  }
}

async function checkJob(job) {
  const status = await kieVideoService.getTaskStatus(job.kie_task_id);
  const state = status.state || status.status;

  if (state === 'success') {
    const resultUrl = kieVideoService.extractResultUrl(status);
    if (!resultUrl) {
      await VideoGenJob.markFailed(job.id, 'Video generated but no result URL was returned');
      return;
    }

    await VideoGenJob.setStatus(job.id, 'downloading');
    const fileName = `${job.id}.mp4`;
    const tempPath = path.join(env.upload.tempDir, fileName);
    let downloadedPath;
    try {
      downloadedPath = await kieVideoService.downloadResult(resultUrl, tempPath);
      const uploaded = await driveService.uploadFile(job.user_id, job.drive_folder_id, downloadedPath, fileName);
      await VideoGenJob.markCompleted(job.id, { driveFileId: uploaded.id, driveFileName: uploaded.name });
      await Log.record(job.user_id, 'Video Generated', { topic: job.topic, driveFileName: uploaded.name });
      await notifyUploadEvent(job.user_id, { type: 'success', videoName: uploaded.name, pageName: 'Video Generation' });
    } finally {
      driveService.deleteTempFile(downloadedPath);
    }
  } else if (state === 'fail') {
    const message = status.failMsg || status.failReason || 'Video generation failed';
    await VideoGenJob.markFailed(job.id, message);
    await Log.record(job.user_id, 'Video Generation Failed', { topic: job.topic, error: message }, 'error');
  }
  // waiting / queuing / generating -> leave as-is, will check again next tick
}

function startVideoGenWorker() {
  cron.schedule(env.kie.pollCron, async () => {
    try {
      const jobs = await VideoGenJob.listInProgress();
      for (const job of jobs) {
        try {
          await checkJob(job);
        } catch (err) {
          logger.error(`[video-gen] check failed for job ${job.id}: ${err.message}`);
          const ageMs = Date.now() - new Date(job.created_at).getTime();
          if (ageMs > 10 * 60 * 1000) {
            // Stuck for over 10 minutes with a real error each time -> stop retrying and surface it
            await VideoGenJob.markFailed(job.id, err.message);
          }
        }
      }
    } catch (err) {
      logger.error(`Video gen worker error: ${err.message}`);
    }
  });
  logger.info(`Video generation poller started with cron: ${env.kie.pollCron}`);
}

module.exports = { startVideoGenWorker, generateWithVertex };
