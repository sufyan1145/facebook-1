const axios = require('axios');
const fs = require('fs');
const env = require('./config.env');
const logger = require('./utils.logger');

const TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

// Synthesizes text to an MP3 file on disk, returns the file path.
async function synthesizeToFile(text, destPath, voiceName) {
  const resp = await axios.post(
    TTS_URL,
    {
      input: { text },
      voice: { languageCode: (voiceName || env.googleAi.defaultVoice).slice(0, 5), name: voiceName || env.googleAi.defaultVoice },
      audioConfig: { audioEncoding: 'MP3' },
    },
    { params: { key: env.googleAi.ttsApiKey } }
  );

  const audioContent = resp.data.audioContent;
  if (!audioContent) throw new Error('Google TTS returned no audio content');

  fs.writeFileSync(destPath, Buffer.from(audioContent, 'base64'));
  logger.info(`[content-pipeline] voiceover saved to ${destPath}`);
  return destPath;
}

module.exports = { synthesizeToFile };
