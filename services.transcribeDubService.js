/**
 * Client for the user's own self-hosted Transcribe-Dub API (Whisper
 * transcription + NLLB translation + Kokoro TTS dubbing), currently reached
 * through a Cloudflare Tunnel while it runs on their PC.
 *
 * Flow: POST /api/v1/dub (multipart: file, target_language, source_language)
 *       -> returns the dubbed audio (.wav) directly as the response body.
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

// Processing a several-minute video through Whisper + NLLB + Kokoro on a
// CPU-only machine can take multiple minutes - keep the timeout generous.
const DUB_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Sends a video/audio file to the transcribe-dub API and gets back a dubbed
 * audio (.wav) file, saved to destAudioPath.
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

  const form = new FormData();
  form.append('file', fs.createReadStream(sourceFilePath));
  form.append('target_language', targetLanguage);
  if (sourceLanguage) form.append('source_language', sourceLanguage);

  try {
    const resp = await axios.post(`${baseUrl}/api/v1/dub`, form, {
      headers: form.getHeaders(),
      responseType: 'arraybuffer',
      timeout: DUB_TIMEOUT_MS,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    fs.writeFileSync(destAudioPath, Buffer.from(resp.data));
    return destAudioPath;
  } catch (err) {
    // err.response.data is an arraybuffer here (since responseType is set
    // above), so decode it to read the actual {"detail": "..."} error the
    // API sends back - otherwise this just logs "[object ArrayBuffer]".
    let detail = err.message;
    if (err.response?.data) {
      try {
        detail = JSON.parse(Buffer.from(err.response.data).toString('utf8')).detail || detail;
      } catch (_) {
        // response wasn't JSON - fall back to err.message
      }
    }
    logger.error(`[transcribe-dub] dub FAILED: ${detail}`);
    throw new Error(detail);
  }
}

module.exports = { dubVideo };
