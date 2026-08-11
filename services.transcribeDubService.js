/**
 * Client for the user's own self-hosted Transcribe-Dub API (Whisper
 * transcription + NLLB translation + Kokoro TTS dubbing), currently reached
 * through a Cloudflare Tunnel while it runs on their PC.
 *
 * Uses an async start-then-poll flow rather than one long request, because
 * Cloudflare's free Quick Tunnels cut off any single request/response after
 * roughly ~120 seconds regardless of what timeout is configured on either
 * end - and a real dub job (transcribe + translate + TTS on a CPU-only
 * machine) routinely takes several minutes. Each individual call here
 * (start, each status poll, the final result fetch) stays well under that
 * limit; only the overall wait (spread across many short polls) is long.
 *
 * Flow: POST /api/v1/dub-start (multipart: file, target_language,
 *       source_language) -> {job_id}
 *       GET  /api/v1/dub-status/{job_id} -> {status, error} - poll this
 *       GET  /api/v1/dub-result/{job_id} -> the dubbed audio (.wav) once
 *       status is "done"
 *
 * NOTE: TRANSCRIBE_DUB_API_URL must be updated in Railway whenever the
 * Cloudflare Quick Tunnel restarts (its URL changes every time) or when this
 * moves to a permanently-hosted machine.
 */
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const env = require('./config.env');
const logger = require('./utils.logger');

const POLL_INTERVAL_MS = 5 * 1000;
const MAX_WAIT_MS = 20 * 60 * 1000; // covers even a long video on a slow CPU
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000; // dub-start includes uploading the whole video file - can be slow on a mobile-network tunnel
const POLL_TIMEOUT_MS = 30 * 1000; // status polls carry no file, should always be fast
const RESULT_TIMEOUT_MS = 2 * 60 * 1000; // fetching the finished audio file

function extractErrorDetail(err) {
  if (err.response?.data) {
    // dub-result's error responses come back as an arraybuffer (since that
    // call sets responseType: 'arraybuffer' to receive the audio file), so
    // decode it to read the actual {"detail": "..."} the API sent -
    // otherwise this just logs "[object ArrayBuffer]".
    if (Buffer.isBuffer(err.response.data) || err.response.data instanceof ArrayBuffer) {
      try {
        const parsed = JSON.parse(Buffer.from(err.response.data).toString('utf8'));
        return parsed.detail || err.message;
      } catch (_) {
        return err.message;
      }
    }
    // start/status responses are normal JSON, axios parses these already
    return err.response.data.detail || err.message;
  }
  return err.message;
}

/**
 * Sends a video/audio file to the transcribe-dub API and gets back a dubbed
 * audio (.wav) file, saved to destAudioPath. Internally starts the job then
 * polls until it's done - see the file header for why.
 *
 * @param {string} sourceFilePath - path to the video/audio file to dub
 * @param {string} destAudioPath - where to save the resulting .wav
 * @param {string} targetLanguage - e.g. "hindi", "english", "chinese" (see
 *   the transcribe-dub module's supported language list)
 * @param {string|null} sourceLanguage - optional hint, e.g. "chinese".
 *   Leave null/empty to auto-detect.
 */
async function dubVideo(sourceFilePath, destAudioPath, targetLanguage, sourceLanguage = null) {
  const baseUrl = env.transcribeDub.apiUrl;
  if (!baseUrl) throw new Error('TRANSCRIBE_DUB_API_URL is not set');
  if (!targetLanguage) throw new Error('A target language is required for dubbing');

  // 1. Start the job - this call itself is just an upload, returns fast.
  const form = new FormData();
  form.append('file', fs.createReadStream(sourceFilePath));
  form.append('target_language', targetLanguage);
  if (sourceLanguage) form.append('source_language', sourceLanguage);

  let jobId;
  try {
    const startResp = await axios.post(`${baseUrl}/api/v1/dub-start`, form, {
      headers: form.getHeaders(),
      timeout: UPLOAD_TIMEOUT_MS,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    jobId = startResp.data.job_id;
    logger.info(`[transcribe-dub] job ${jobId} started`);
  } catch (err) {
    const detail = extractErrorDetail(err);
    logger.error(`[transcribe-dub] dub-start FAILED: ${detail}`);
    throw new Error(detail);
  }

  // 2. Poll status until done/error/timeout. Each poll is a quick call, so
  //    none of these individually risk the tunnel's ~120s cutoff - only the
  //    overall loop runs long.
  const startedAt = Date.now();
  while (Date.now() - startedAt < MAX_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    let statusResp;
    try {
      statusResp = await axios.get(`${baseUrl}/api/v1/dub-status/${jobId}`, { timeout: POLL_TIMEOUT_MS });
    } catch (err) {
      // a single poll failing (e.g. a momentary tunnel blip) isn't fatal -
      // just try again on the next interval
      logger.error(`[transcribe-dub] status poll failed, retrying: ${err.message}`);
      continue;
    }

    const { status, error } = statusResp.data;
    if (status === 'done') {
      // 3. Fetch the finished audio.
      try {
        const resultResp = await axios.get(`${baseUrl}/api/v1/dub-result/${jobId}`, {
          responseType: 'arraybuffer',
          timeout: RESULT_TIMEOUT_MS,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        });
        fs.writeFileSync(destAudioPath, Buffer.from(resultResp.data));
        logger.info(`[transcribe-dub] job ${jobId} done, audio saved`);
        return destAudioPath;
      } catch (err) {
        const detail = extractErrorDetail(err);
        logger.error(`[transcribe-dub] dub-result FAILED: ${detail}`);
        throw new Error(detail);
      }
    }

    if (status === 'error') {
      logger.error(`[transcribe-dub] job ${jobId} failed: ${error}`);
      throw new Error(error || 'Dubbing failed');
    }
    // else status === 'processing' - keep polling
  }

  throw new Error(`Dubbing job ${jobId} did not finish within ${MAX_WAIT_MS / 60000} minutes`);
}

module.exports = { dubVideo };
