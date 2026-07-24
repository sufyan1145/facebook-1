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
async function writeScript(keyword, { sceneCount, sceneSeconds, language }) {
  logger.info(`[Gemini] Using model value: ${JSON.stringify(env.googleAi.geminiModel)} (length: ${env.googleAi.geminiModel.length})`);
  const isRomanUrdu = language === 'roman_urdu';
  const narrationInstruction = isRomanUrdu
    ? 'what the voiceover says. MUST be written ENTIRELY in Roman Urdu (the Urdu language, spelled phonetically using English/Latin letters — NOT Urdu script, NOT English). Example of the required style: "Yeh jungle hazaron saal purana hai aur iski kahani bohot dilchasp hai." Do not write the narration in English.'
    : 'what the voiceover says (plain spoken English, no stage directions)';

  const languageReminder = isRomanUrdu
    ? `\n\nIMPORTANT: Every single "narration" field MUST be in Roman Urdu, not English. This is a strict requirement — only "topic" and "visual_prompt" stay in English.`
    : '';

  const prompt = `You are writing a short documentary-style video script about: "${keyword}".

Pick ONE specific, interesting angle or fact within this topic (not a generic overview) so the video feels fresh.
Write exactly ${sceneCount} scenes. Each scene is about ${sceneSeconds} seconds of narration (roughly ${Math.round(sceneSeconds * 2.5)} words).
For each scene, give:
- "narration": ${narrationInstruction}
- "visual_prompt": a detailed, specific still-image description IN ENGLISH (used to generate a single AI photo for this scene, regardless of narration language) of exactly what should be shown. Describe: the specific subject/action tied directly to what the narration says (not a generic stand-in image), the setting/background, camera framing (e.g. "close-up", "wide establishing shot", "aerial view"), lighting mood (e.g. "golden hour", "moody overcast", "dramatic side-lighting"), and visual style ("photorealistic, cinematic, highly detailed"). Each scene's visual_prompt must be visually distinct from the others (avoid repeating the same shot/subject/framing twice).
${languageReminder}
Respond with ONLY valid JSON, no markdown, no code fences, in this exact shape:
{
  "topic": "specific title for this video",
  "scenes": [
    { "narration": "...", "visual_prompt": "..." }
  ]
}`;

  let resp;
  try {
    resp = await retryOn429(
      () =>
        axios.post(
          `${BASE_URL}/models/${env.googleAi.geminiModel}:generateContent`,
          { contents: [{ parts: [{ text: prompt }] }] },
          { params: { key: env.googleAi.geminiApiKey } }
        ),
      { label: 'Gemini script' }
    );
  } catch (err) {
    const geminiError = err.response?.data?.error;
    logger.error(`[Gemini] writeScript FAILED: ${JSON.stringify(geminiError || err.message)}`);
    throw new Error(geminiError?.message || err.message);
  }

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

module.exports = { writeScript, generateImage };

/**
 * Generates a still image from a text prompt using Gemini's own image model
 * (gemini-2.5-flash-image, aka "Nano Banana"). Saves the result as a PNG file.
 * This is a free-tier alternative to paying for Kie.ai image credits.
 */
async function generateImage(prompt, destPath) {
  const fs = require('fs');
  const model = env.googleAi.imageModel;
  logger.info(`[Gemini] generateImage using model: ${JSON.stringify(model)}`);

  let resp;
  try {
    resp = await retryOn429(
      () =>
        axios.post(
          `${BASE_URL}/models/${model}:generateContent`,
          {
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['IMAGE'] },
          },
          { params: { key: env.googleAi.geminiApiKey } }
        ),
      { label: 'Gemini image' }
    );
  } catch (err) {
    const geminiError = err.response?.data?.error;
    logger.error(`[Gemini] generateImage FAILED: ${JSON.stringify(geminiError || err.message)}`);
    throw new Error(geminiError?.message || err.message);
  }

  const parts = resp.data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart) throw new Error('Gemini returned no image data');

  fs.writeFileSync(destPath, Buffer.from(imagePart.inlineData.data, 'base64'));
  return destPath;
}
