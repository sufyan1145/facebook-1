/**
 * TTS via the user's own self-hosted Avatar Video Tool API (Kokoro TTS),
 * currently reached through a Cloudflare Tunnel while it runs on their PC.
 * Avoids Google Cloud TTS billing entirely - no cost per request.
 *
 * Flow: POST /api/v1/generate-speech -> {status, audio_path}
 *       GET  /api/v1/download?path=<audio_path> -> actual audio bytes
 *
 * NOTE: AVATAR_API_URL must be updated in Railway whenever the Cloudflare
 * Quick Tunnel restarts (its URL changes every time) or when this moves to
 * a permanently-hosted GPU machine.
 */
const axios = require('axios');
const fs = require('fs');
const env = require('./config.env');
const logger = require('./utils.logger');

async function synthesizeSpeech(text, destPath, voiceName) {
  const baseUrl = env.customTts.apiUrl;
  if (!baseUrl) throw new Error('AVATAR_API_URL is not set');

  let audioPath;
  try {
    const genResp = await axios.post(
      `${baseUrl}/api/v1/generate-speech`,
      { text, language: 'en', speaker_wav: '', speed: 1 },
      { headers: { 'Content-Type': 'application/json' }, timeout: 5 * 60 * 1000 }
    );
    if (genResp.data.status !== 'ok' || !genResp.data.audio_path) {
      throw new Error(`Unexpected response: ${JSON.stringify(genResp.data)}`);
    }
    audioPath = genResp.data.audio_path;
  } catch (err) {
    const detail = err.response?.data;
    logger.error(`[custom-tts] generate-speech FAILED: ${JSON.stringify(detail || err.message)}`);
    throw new Error(detail?.detail || detail?.message || err.message);
  }

  try {
    const downloadResp = await axios.get(`${baseUrl}/api/v1/download`, {
      params: { path: audioPath },
      responseType: 'arraybuffer',
      timeout: 5 * 60 * 1000,
    });
    fs.writeFileSync(destPath, Buffer.from(downloadResp.data));
  } catch (err) {
    logger.error(`[custom-tts] download FAILED for path ${audioPath}: ${err.message}`);
    throw new Error(`Failed to download generated audio: ${err.message}`);
  }

  return destPath;
}

module.exports = { synthesizeSpeech };
