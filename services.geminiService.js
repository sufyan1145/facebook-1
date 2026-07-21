const axios = require('axios');
const env = require('./config.env');
const logger = require('./utils.logger');
const { retryOn429 } = require('./utils.retry');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Turns a keyword into a fresh video topic + a scene-by-scene script.
 * Each scene has narration (what the voiceover says) and a visual_prompt
 * (what the video clip for that scene should show).
 */
async function writeScript(keyword, { sceneCount, sceneSeconds }) {
  const prompt = `You are writing a short documentary-style video script about: "${keyword}".

Pick ONE specific, interesting angle or fact within this topic (not a generic overview) so the video feels fresh.
Write exactly ${sceneCount} scenes. Each scene is about ${sceneSeconds} seconds of narration (roughly ${Math.round(sceneSeconds * 2.5)} words).
For each scene, give:
- "narration": what the voiceover says (plain spoken English, no stage directions)
- "visual_prompt": a short, concrete visual description (for an AI video generator) of what should be shown on screen during that narration, cinematic and specific.

Respond with ONLY valid JSON, no markdown, no code fences, in this exact shape:
{
  "topic": "specific title for this video",
  "scenes": [
    { "narration": "...", "visual_prompt": "..." }
  ]
}`;

  const resp = await retryOn429(
    () =>
      axios.post(
        `${BASE_URL}/models/${env.googleAi.geminiModel}:generateContent`,
        { contents: [{ parts: [{ text: prompt }] }] },
        { params: { key: env.googleAi.geminiApiKey } }
      ),
    { label: 'Gemini script' }
  );

  const text = resp.data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned no script text');

  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    logger.error(`[content-pipeline] failed to parse Gemini script JSON: ${cleaned.slice(0, 300)}`);
    throw new Error('Gemini did not return valid JSON for the script');
  }

  if (!parsed.topic || !Array.isArray(parsed.scenes) || !parsed.scenes.length) {
    throw new Error('Gemini script response was missing topic/scenes');
  }
  return parsed;
}

module.exports = { writeScript };
