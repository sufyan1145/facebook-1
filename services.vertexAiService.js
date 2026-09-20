const axios = require('axios');
const fs = require('fs');
const { GoogleAuth } = require('google-auth-library');
const env = require('./config.env');
const logger = require('./utils.logger');
const { retryOn429 } = require('./utils.retry');

let authClient = null;

function getAuth() {
  if (!authClient) {
    if (!env.vertexAi.credentialsBase64) {
      throw new Error('VERTEX_CREDENTIALS_BASE64 is not set');
    }
    const credentials = JSON.parse(Buffer.from(env.vertexAi.credentialsBase64, 'base64').toString('utf8'));
    authClient = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
  }
  return authClient;
}

async function getAccessToken() {
  const client = await getAuth().getClient();
  const token = await client.getAccessToken();
  return typeof token === 'string' ? token : token.token;
}

// Vertex ke endpoint hostname ki 3 alag shapes hain - location ke hisaab se:
//   global          -> aiplatform.googleapis.com              (koi prefix nahi)
//   us / eu         -> aiplatform.<loc>.rep.googleapis.com    (multi-region REP host)
//   koi bhi region  -> <loc>-aiplatform.googleapis.com        (single region)
// "global-aiplatform.googleapis.com" jaisa koi host exist hi nahi karta, isliye
// wahan Google ka generic 404 HTML page wapas aata tha.
const MULTI_REGION_LOCATIONS = new Set(['us', 'eu']);

function vertexHost(location) {
  if (location === 'global') return 'aiplatform.googleapis.com';
  if (MULTI_REGION_LOCATIONS.has(location)) return `aiplatform.${location}.rep.googleapis.com`;
  return `${location}-aiplatform.googleapis.com`;
}

function baseUrl() {
  const location = (env.vertexAi.location || 'us-central1').trim().toLowerCase();
  return `https://${vertexHost(location)}/v1/projects/${env.vertexAi.projectId}/locations/${location}/publishers/google/models`;
}

// ---- Veo3 video generation ----

async function createVeoVideoTask({ prompt, duration, aspectRatio, generateAudio = false }) {
  const token = await getAccessToken();
  const requestBody = {
    instances: [{ prompt }],
    parameters: {
      aspectRatio: aspectRatio || '9:16',
      durationSeconds: String(Math.min(Math.round(duration), 8)),
      generateAudio,
      resolution: '720p',
    },
  };
  logger.info(`[vertex] veo generate request: ${JSON.stringify(requestBody)}, url: ${baseUrl()}/${env.vertexAi.veoModel}:predictLongRunning`);

  let resp;
  try {
    resp = await axios.post(
      `${baseUrl()}/${env.vertexAi.veoModel}:predictLongRunning`,
      requestBody,
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const detail = err.response?.data;
    logger.error(`[vertex] veo generate FAILED: status=${err.response?.status} detail=${JSON.stringify(detail)}`);
    throw new Error(detail?.error?.message || err.message);
  }
  logger.info(`[vertex] veo generate response: ${JSON.stringify(resp.data)}`);

  const operationName = resp.data.name;
  if (!operationName) throw new Error(`Vertex AI did not return an operation name: ${JSON.stringify(resp.data)}`);
  return operationName;
}

async function getVeoOperationStatus(operationName) {
  const token = await getAccessToken();
  const resp = await axios.post(
    `${baseUrl()}/${env.vertexAi.veoModel}:fetchPredictOperation`,
    { operationName },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return resp.data;
}

function extractVeoResultBytes(status) {
  const video = status.response?.videos?.[0];
  return video?.bytesBase64Encoded || null;
}

// ---- Nano Banana (Gemini image) via Vertex ----

async function generateImage(prompt, destPath) {
  const token = await getAccessToken();
  let resp;
  try {
    resp = await retryOn429(
      () =>
        axios.post(
          `${baseUrl()}/${env.vertexAi.imageModel}:generateContent`,
          {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['IMAGE'] },
          },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        ),
      { label: 'Vertex image generation (Nano Banana)' }
    );
  } catch (err) {
    const detail = err.response?.data;
    logger.error(`[vertex] image generate FAILED: status=${err.response?.status} detail=${JSON.stringify(detail)}`);
    throw new Error(detail?.error?.message || err.message);
  }

  const parts = resp.data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data);
  if (!imagePart) throw new Error('Vertex AI returned no image data');

  fs.writeFileSync(destPath, Buffer.from(imagePart.inlineData.data, 'base64'));
  return destPath;
}

// ---- Cloud Text-to-Speech (separate, simpler Google Cloud API) ----

// Chirp3-HD voice character names (Charon, Iapetus, Kore, etc.) are shared
// across languages - only the locale prefix changes. Hardcoding "en-US-" here
// meant every voiceover was read by an ENGLISH voice, so Urdu narration (even
// correctly-written Urdu-script text) came out sounding English-accented.
const TTS_LANGUAGE_CODES = {
  english: 'en-US',
  roman_urdu: 'en-US', // Latin-letter transliteration - only an English voice can read the letters at all
  urdu: 'ur-IN', // proper Urdu script - needs the real Urdu voice to pronounce correctly
};

async function synthesizeSpeech(text, destPath, voiceName, language) {
  const token = await getAccessToken();
  const languageCode = TTS_LANGUAGE_CODES[language] || 'en-US';
  const chirpVoiceName = `${languageCode}-Chirp3-HD-${voiceName || 'Charon'}`;
  let resp;
  try {
    resp = await retryOn429(
      () =>
        axios.post(
          'https://texttospeech.googleapis.com/v1/text:synthesize',
          {
            input: { text },
            voice: { languageCode, name: chirpVoiceName },
            audioConfig: { audioEncoding: 'MP3' },
          },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        ),
      { label: 'Vertex Cloud TTS' }
    );
  } catch (err) {
    const detail = err.response?.data;
    logger.error(`[vertex] TTS FAILED (voice=${chirpVoiceName}, text length=${text.length}): status=${err.response?.status} detail=${JSON.stringify(detail)}`);
    throw new Error(detail?.error?.message || err.message);
  }

  if (!resp.data.audioContent) throw new Error('Cloud Text-to-Speech returned no audio');
  fs.writeFileSync(destPath, Buffer.from(resp.data.audioContent, 'base64'));
  return destPath;
}

// ---- Script writing (same prompt/response contract as services.geminiService.js's
// writeScript, but via Vertex AI's billing account instead of the AI Studio free-tier
// key - avoids the Gemini API's free-tier daily request quota entirely) ----

async function writeScript(keyword, { sceneCount, sceneSeconds, language, masterPrompt, contentFormat }) {
  const isRomanUrdu = language === 'roman_urdu';
  // Real Urdu script (not transliterated) - required for the ur-IN Chirp3-HD TTS
  // voice to pronounce it correctly. Roman Urdu (Latin letters) gets read with
  // English phonetics by any TTS engine, which is why it sounds "English-accented"
  // even though the words are Urdu - the voice model needs actual Urdu script input.
  const isUrduScript = language === 'urdu';
  const narrationInstruction = isRomanUrdu
    ? 'what the voiceover says. MUST be written ENTIRELY in Roman Urdu (the Urdu language, spelled phonetically using English/Latin letters — NOT Urdu script, NOT English). Example of the required style: "Yeh jungle hazaron saal purana hai aur iski kahani bohot dilchasp hai." Do not write the narration in English.'
    : isUrduScript
    ? 'what the voiceover says. MUST be written ENTIRELY in proper Urdu script (Perso-Arabic/Nastaliq, right-to-left) — NOT Roman/Latin letters, NOT English. Example of the required style: "یہ جنگل ہزاروں سال پرانا ہے اور اس کی کہانی بہت دلچسپ ہے۔" Do not romanize the narration.'
    : 'what the voiceover says (plain spoken English, no stage directions)';

  const languageReminder = isRomanUrdu
    ? `\n\nIMPORTANT: Every single "narration" field MUST be in Roman Urdu, not English. This is a strict requirement — only "topic" and "visual_prompt" stay in English.`
    : isUrduScript
    ? `\n\nIMPORTANT: Every single "narration" field MUST be written in real Urdu script (Perso-Arabic letters), not Roman/Latin letters and not English. This is a strict requirement — only "topic" and "visual_prompt" stay in English.`
    : '';

  const masterPromptBlock = masterPrompt && masterPrompt.trim()
    ? `\n\nCREATOR'S CUSTOM INSTRUCTIONS (follow these closely for both the narration's tone/style and the visual_prompt's look/style, in addition to everything else above):\n"""\n${masterPrompt.trim()}\n"""`
    : '';

  const formatFramings = {
    documentary: 'a short documentary-style video script',
    tutorial: 'a short step-by-step tutorial/how-to video script (practical, instructional, second-person "you" voice)',
    tips: 'a fast-paced "tips and tricks" style video script (punchy, listicle-style, one clear tip per scene)',
    vlog: 'a personal, casual talking-head vlog-style video script (first-person, conversational, like a creator sharing their own experience/opinion)',
    news: 'a news/commentary-style video script (informative, current-events framing, neutral-to-opinionated tone)',
  };
  const framing = formatFramings[contentFormat] || formatFramings.documentary;

  const prompt = `You are writing ${framing} about: "${keyword}".

Pick ONE specific, interesting angle or fact within this topic (not a generic overview) so the video feels fresh.
Write exactly ${sceneCount} scenes. Each scene is about ${sceneSeconds} seconds of narration (roughly ${Math.round(sceneSeconds * 2.5)} words).
For each scene, give:
- "narration": ${narrationInstruction}
- "visual_prompt": a detailed, specific still-image description IN ENGLISH (used to generate a single AI photo for this scene, regardless of narration language) of exactly what should be shown. Describe: the specific subject/action tied directly to what the narration says (not a generic stand-in image), the setting/background, camera framing (e.g. "close-up", "wide establishing shot", "aerial view"), lighting mood (e.g. "golden hour", "moody overcast", "dramatic side-lighting"), and visual style ("photorealistic, cinematic, highly detailed"). Each scene's visual_prompt must be visually distinct from the others (avoid repeating the same shot/subject/framing twice).
${languageReminder}${masterPromptBlock}
Respond with ONLY valid JSON, no markdown, no code fences, in this exact shape:
{
  "topic": "specific title for this video",
  "scenes": [
    { "narration": "...", "visual_prompt": "..." }
  ]
}`;

  const token = await getAccessToken();
  let resp;
  try {
    resp = await axios.post(
      `${baseUrl()}/${env.vertexAi.scriptModel}:generateContent`,
      { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const detail = err.response?.data;
    logger.error(`[vertex] writeScript FAILED: status=${err.response?.status} detail=${JSON.stringify(detail)}`);
    throw new Error(detail?.error?.message || err.message);
  }

  const text = resp.data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Vertex AI returned no script text');

  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    logger.error(`[content-pipeline] failed to parse Vertex script JSON: ${cleaned.slice(0, 300)}`);
    throw new Error('Vertex AI did not return valid JSON for the script');
  }

  if (!parsed.topic || !Array.isArray(parsed.scenes) || !parsed.scenes.length) {
    throw new Error('Vertex script response was missing topic/scenes');
  }
  return parsed;
}

/**
 * Takes a user-SUPPLIED narration script word-for-word (never rewritten -
 * the user's exact wording is preserved) and only asks the model to (a)
 * split it into scenes of roughly `clipSeconds` seconds each and (b) write
 * a visual_prompt for each scene. This was previously called as
 * geminiService.writeVisualPromptsForScript(...) in
 * jobs.contentPipelineWorker.js, but that function was never actually
 * defined anywhere in the codebase - every custom-script schedule crashed
 * immediately with "writeVisualPromptsForScript is not a function". This is
 * the first real implementation, on Vertex so it shares the same billing
 * account as everything else instead of needing a separate AI Studio key.
 */
async function writeVisualPromptsForScript(customScript, { clipSeconds = 10, masterPrompt, contentFormat } = {}) {
  const masterPromptBlock = masterPrompt && masterPrompt.trim()
    ? `\n\nCREATOR'S CUSTOM INSTRUCTIONS (follow these closely for the visual_prompt's look/style only - the narration wording below is fixed and must not be changed):\n"""\n${masterPrompt.trim()}\n"""`
    : '';

  const prompt = `Below is a complete, word-for-word narration script that a person has already written for a short video. Do NOT rewrite, translate, paraphrase, or correct it in any way - copy each piece of it into the "narration" fields EXACTLY as given, preserving the original language/script.

NARRATION SCRIPT (verbatim, in order):
"""
${customScript.trim()}
"""

Your only two jobs:
1. Split the script above into consecutive scenes, each roughly ${clipSeconds} seconds of spoken narration (about ${Math.round(clipSeconds * 2.5)} words), breaking at natural sentence/clause boundaries. Every word of the original script must appear in exactly one scene, in order, with nothing added, removed, or reworded.
2. For each scene, write a "visual_prompt": a detailed, specific still-image description IN ENGLISH (regardless of the narration's language) of exactly what should be shown for that part of the narration - the specific subject/action tied directly to what that scene's narration says, the setting/background, camera framing (e.g. "close-up", "wide establishing shot", "aerial view"), lighting mood, and visual style ("photorealistic, cinematic, highly detailed"). Each scene's visual_prompt must be visually distinct from the others.
${masterPromptBlock}

Respond with ONLY valid JSON, no markdown, no code fences, in this exact shape:
{
  "topic": "<a short 3-8 word title summarizing what this script is about, in English>",
  "scenes": [
    { "narration": "...", "visual_prompt": "..." }
  ]
}`;

  const token = await getAccessToken();
  let resp;
  try {
    resp = await axios.post(
      `${baseUrl()}/${env.vertexAi.scriptModel}:generateContent`,
      { contents: [{ role: 'user', parts: [{ text: prompt }] }] },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const detail = err.response?.data;
    logger.error(`[vertex] writeVisualPromptsForScript FAILED: status=${err.response?.status} detail=${JSON.stringify(detail)}`);
    throw new Error(detail?.error?.message || err.message);
  }

  const text = resp.data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Vertex AI returned no script text');

  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    logger.error(`[content-pipeline] failed to parse Vertex custom-script JSON: ${cleaned.slice(0, 300)}`);
    throw new Error('Vertex AI did not return valid JSON for the custom script');
  }

  if (!Array.isArray(parsed.scenes) || !parsed.scenes.length) {
    throw new Error('Vertex custom-script response was missing scenes');
  }
  if (!parsed.topic) parsed.topic = contentFormat || 'Custom script video';
  return parsed;
}

/**
 * Vertex-billed counterpart to geminiService.generatePostContent - used by
 * services.captionGenService.js (Text+Image posts) so that flow doesn't
 * depend on the separate AI Studio (Gemini API key) project having billing.
 */
async function generatePostContent(topic, { avoidList } = {}) {
  const avoidSection =
    avoidList && avoidList.length
      ? `\n\nIMPORTANT - AVOID REPEATING: these are the captions from the most recent posts on this same schedule. Do NOT feature the same person, the same quote, or the same specific angle as any of these - pick someone/something clearly different this time:\n${avoidList.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
      : '';

  const prompt = `You are generating ONE social media post from the topic/instructions below. The topic may be a single word, a short phrase, or a detailed multi-part instruction - follow it as closely as you reasonably can, for any subject (a public figure, a general theme, a quote/wisdom style, current events framing, anything).

TOPIC/INSTRUCTIONS:
"""
${topic}
"""
${avoidSection}

Respond with STRICT JSON only (no markdown fences, no commentary before or after), with exactly these two keys:
{
  "caption": "<the ready-to-publish post text - respond in the exact same language/script the topic above is written in>",
  "imagePrompt": "<one detailed, realistic image-generation prompt matching the caption - no text, watermark, or logo inside the image, always describe the image in English regardless of the caption's language>"
}

Do not fabricate specific claimed facts, dates, or quotes you are not confident are accurate - if the topic implies needing today's exact news and you are not certain of current details, keep the caption general/evergreen instead of inventing specifics.`;

  const token = await getAccessToken();
  const resp = await axios.post(
    `${baseUrl()}/${env.vertexAi.scriptModel}:generateContent`,
    { contents: [{ parts: [{ text: prompt }] }] },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 60000 }
  );

  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Vertex did not return post content');

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(`Vertex response did not contain valid JSON: ${text.slice(0, 200)}`);
  }
  const jsonSlice = text.slice(firstBrace, lastBrace + 1);

  let parsed;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (parseErr) {
    throw new Error(`Failed to parse Vertex JSON response: ${parseErr.message} - raw: ${jsonSlice.slice(0, 200)}`);
  }
  if (!parsed.caption || !parsed.imagePrompt) throw new Error('Vertex response missing caption or imagePrompt');
  return { caption: parsed.caption.trim(), imagePrompt: parsed.imagePrompt.trim() };
}

/**
 * Vertex-billed counterpart to geminiService.regenerateTitleAndHashtags -
 * used by the TikTok Downloader and Video Editor's "Regenerate title".
 */
async function regenerateTitleAndHashtags(originalTitle, originalDescription) {
  const prompt = `You are rewriting a short video's title and hashtags for social media reposting.

ORIGINAL TITLE: "${originalTitle || ''}"
ORIGINAL DESCRIPTION: "${originalDescription || ''}"

The original may be in ANY language or script. Write a catchy, engaging title IN ENGLISH that captures the same meaning/topic (translate/adapt it, don't just transliterate), and matching relevant English hashtags.

Respond with STRICT JSON only (no markdown fences, no commentary before or after), with exactly these two keys:
{
  "title": "<catchy English title, under 100 characters>",
  "hashtags": "<5-8 relevant English hashtags, space separated, each starting with #>"
}`;

  const token = await getAccessToken();
  const resp = await axios.post(
    `${baseUrl()}/${env.vertexAi.scriptModel}:generateContent`,
    { contents: [{ parts: [{ text: prompt }] }] },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 60000 }
  );

  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Vertex did not return title/hashtags');

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(`Vertex response did not contain valid JSON: ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
  if (!parsed.title) throw new Error('Vertex response missing title');
  return { title: parsed.title.trim(), hashtags: (parsed.hashtags || '').trim() };
}

/**
 * Generates narration lines for the Product Explainer feature: a real,
 * product-focused explainer script (unboxing/features/specs/usage/pricing
 * angles), grounded in the ACTUAL source video's own title/description
 * (real human-written content) rather than inventing facts. Only used when
 * the user hasn't supplied their own custom script - a user-supplied script
 * is always preferred since it's independently verified real information.
 */
async function generateProductExplainerScript(sourceTitle, sourceDescription, lineCount, { narrationLanguage = 'english' } = {}) {
  const prompt = `You are writing the narration script for a real-information product explainer/ad-style video about a product shown in a YouTube video.

SOURCE VIDEO TITLE: "${sourceTitle || ''}"
SOURCE VIDEO DESCRIPTION: "${sourceDescription || ''}"
NARRATION LANGUAGE: ${narrationLanguage}

Using ONLY facts that are actually stated or clearly implied in the title/description above (do not invent specs, prices, or claims that aren't there), write exactly ${lineCount} narration lines covering, in order: what the product is -> its key features -> how it's used -> who it's for -> a closing takeaway. If the description doesn't have enough real detail to fill ${lineCount} lines without inventing facts, keep lines more general/descriptive rather than making up specifics.

Each line should take roughly 4-5 seconds to speak aloud (about 10-14 words), in ${narrationLanguage}, natural spoken ad-style narration (confident, clear, not overly salesy).

Respond with STRICT JSON only (no markdown fences, no commentary), matching exactly this shape:
{ "lines": ["...", "...", "..."] }
The "lines" array must contain exactly ${lineCount} strings, in order.`;

  const token = await getAccessToken();
  const resp = await axios.post(
    `${baseUrl()}/${env.vertexAi.scriptModel}:generateContent`,
    { contents: [{ parts: [{ text: prompt }] }] },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 120000 }
  );

  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Vertex did not return narration lines');
  const cleaned = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  const lines = (parsed.lines || []).map((l) => String(l).trim()).filter(Boolean);
  if (!lines.length) throw new Error('Vertex returned no narration lines');
  while (lines.length < lineCount) lines.push(lines[lines.length - 1]);
  return { lines: lines.slice(0, lineCount) };
}

/**
 * Vertex-billed counterpart to geminiService.generateReactionNarrationLines -
 * used so the News Reaction video builder doesn't depend on the AI Studio
 * (Gemini API key) project having its own separate billing enabled.
 */
async function generateReactionNarrationLines(sourceTitle, sourceDescription, lineCount, { narrationLanguage = 'english' } = {}) {
  const prompt = `You are writing the narration script for a short "news reaction / explainer" video that reacts to and explains an existing news video, in the style of a commentary/analysis channel.

SOURCE VIDEO TITLE: "${sourceTitle || ''}"
SOURCE VIDEO DESCRIPTION: "${sourceDescription || ''}"
NARRATION LANGUAGE: ${narrationLanguage}

Write exactly ${lineCount} narration lines, in order, that together form one continuous reaction moving through the story from start to finish (setup -> key moments -> reaction/context -> closing thought). Each line plays while the viewer sees a still image of that moment, so write it like a narrator/commentator talking OVER a still, reacting to and explaining what's happening - not describing an image.

Each line should take roughly 8-10 seconds to speak aloud at a natural pace (about 20-28 words), in ${narrationLanguage}, 1-2 sentences, natural spoken style (not written/formal).

Respond with STRICT JSON only (no markdown fences, no commentary before or after), matching exactly this shape:
{ "lines": ["...", "...", "..."] }
The "lines" array must contain exactly ${lineCount} strings, in order.`;

  const token = await getAccessToken();
  const resp = await axios.post(
    `${baseUrl()}/${env.vertexAi.scriptModel}:generateContent`,
    { contents: [{ parts: [{ text: prompt }] }] },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 120000 }
  );

  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Vertex did not return narration lines');
  const cleaned = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed.lines) || parsed.lines.length === 0) throw new Error('Vertex returned no narration lines');
  const lines = parsed.lines.map((l) => String(l).trim()).filter(Boolean);
  while (lines.length < lineCount) lines.push(lines[lines.length - 1] || sourceTitle || 'And that brings us to the end of this story.');
  return { lines: lines.slice(0, lineCount) };
}

/**
 * Groups narration lines (whether AI-written or the user's own custom
 * script) into small batches and asks for ONE YouTube search query per
 * batch describing the shared visual moment - e.g. several consecutive
 * lines about the same feature all get one query like "wireless earbuds
 * noise cancellation demo". This is what keeps YouTube Data API usage to a
 * handful of searches per video instead of one per narration line - see
 * config.env.js productExplainer.linesPerSearchGroup.
 */
async function generateVisualSearchQueries(productContext, lines, groupSize) {
  const groups = [];
  for (let i = 0; i < lines.length; i += groupSize) groups.push(lines.slice(i, i + groupSize));

  const groupsText = groups.map((g, i) => `Group ${i + 1}:\n${g.map((l) => `- ${l}`).join('\n')}`).join('\n\n');
  const prompt = `A product explainer video about: "${productContext}"

Below are groups of consecutive narration lines from the script. For EACH group, write ONE short YouTube search query (3-6 words) that would find a real video showing the product doing/being what that group of lines describes.

${groupsText}

Respond with STRICT JSON only (no markdown fences, no commentary), matching exactly this shape:
{ "queries": ["query for group 1", "query for group 2", "..."] }
The "queries" array must have exactly ${groups.length} strings, in the same order as the groups above.`;

  const token = await getAccessToken();
  const resp = await axios.post(
    `${baseUrl()}/${env.vertexAi.scriptModel}:generateContent`,
    { contents: [{ parts: [{ text: prompt }] }] },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 120000 }
  );

  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Vertex did not return search queries');
  const cleaned = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  const queries = (parsed.queries || []).map((q) => String(q).trim()).filter(Boolean);
  while (queries.length < groups.length) queries.push(productContext);

  // Expand back out so there's one query per original line (every line in a
  // group shares that group's query) - simpler for the caller to consume.
  const perLineQueries = [];
  groups.forEach((g, i) => g.forEach(() => perLineQueries.push(queries[i])));
  return perLineQueries;
}

module.exports = {
  createVeoVideoTask,
  getVeoOperationStatus,
  extractVeoResultBytes,
  generateImage,
  synthesizeSpeech,
  writeScript,
  writeVisualPromptsForScript,
  generateProductExplainerScript,
  generateReactionNarrationLines,
  generateVisualSearchQueries,
  generatePostContent,
  regenerateTitleAndHashtags,
};
