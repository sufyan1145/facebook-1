const axios = require('axios');
const fs = require('fs');
const env = require('./config.env');
const logger = require('./utils.logger');
const ffmpeg = require('./utils.ffmpeg');
const { retryOn429 } = require('./utils.retry');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// Uses Gemini's own TTS-capable models (same simple GEMINI_API_KEY, no GCP
// project or billing needed) instead of Google Cloud Text-to-Speech.
async function synthesizeToFile(text, destPath, voiceName) {
  const resp = await retryOn429(
    () =>
      axios.post(
        `${BASE_URL}/models/gemini-2.5-flash-preview-tts:generateContent`,
        {
          contents: [{ parts: [{ text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName || env.googleAi.defaultVoice } } },
          },
        },
        { params: { key: env.googleAi.geminiApiKey } }
      ),
    { label: 'Gemini TTS' }
  );

  const part = resp.data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!part?.data) throw new Error('Gemini TTS returned no audio data');

  const audioBuffer = Buffer.from(part.data, 'base64');

  if (part.mimeType && /mp3|mpeg/i.test(part.mimeType)) {
    fs.writeFileSync(destPath, audioBuffer);
  } else {
    // Gemini TTS usually returns raw 16-bit PCM at 24kHz with no header - convert via ffmpeg
    const pcmPath = destPath.replace(/\.mp3$/, '.pcm');
    fs.writeFileSync(pcmPath, audioBuffer);
    await ffmpeg.pcmToMp3(pcmPath, destPath);
    fs.unlinkSync(pcmPath);
  }

  logger.info(`[content-pipeline] voiceover saved to ${destPath}`);
  return destPath;
}

module.exports = { synthesizeToFile };
