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
async function writeScript(keyword, { sceneCount, sceneSeconds, language, masterPrompt, contentFormat }) {
  logger.info(`[Gemini] Using model value: ${JSON.stringify(env.googleAi.geminiModel)} (length: ${env.googleAi.geminiModel.length})`);
  const isRomanUrdu = language === 'roman_urdu';
  const narrationInstruction = isRomanUrdu
    ? 'what the voiceover says. MUST be written ENTIRELY in Roman Urdu (the Urdu language, spelled phonetically using English/Latin letters — NOT Urdu script, NOT English). Example of the required style: "Yeh jungle hazaron saal purana hai aur iski kahani bohot dilchasp hai." Do not write the narration in English.'
    : 'what the voiceover says (plain spoken English, no stage directions)';

  const languageReminder = isRomanUrdu
    ? `\n\nIMPORTANT: Every single "narration" field MUST be in Roman Urdu, not English. This is a strict requirement — only "topic" and "visual_prompt" stay in English.`
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

/**
 * Generates a short, fresh social media caption about a topic, in whatever
 * language the topic itself is written in (e.g. a Roman Urdu or Urdu-script
 * topic gets a caption in that same language back). Used by Text+Image Post
 * schedules in "topic" mode, so every scheduled run posts new wording instead
 * of repeating the same caption.
 */
async function generateCaption(topic, { retries } = {}) {
  const prompt = `Write ONE short, engaging social media caption (under 300 characters, no hashtag spam, natural human tone, not repetitive/generic) about this topic: "${topic}".
Respond in the exact same language and script the topic is written in - if the topic is in Roman Urdu, reply in Roman Urdu; if it's in Urdu script, reply in Urdu script; if English, reply in English; and so on for any other language.
Reply with ONLY the caption text itself - no quotes, no labels, no extra commentary.`;

  const resp = await retryOn429(
    () =>
      axios.post(
        `${BASE_URL}/models/${env.googleAi.geminiModel}:generateContent`,
        { contents: [{ parts: [{ text: prompt }] }] },
        { params: { key: env.googleAi.geminiApiKey }, timeout: 60000 }
      ),
    { label: 'Gemini caption', retries }
  );

  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini did not return caption text');
  return text.trim();
}

/**
 * Generates a fresh, matching (caption + image prompt) pair for a Text+Image
 * Post schedule's "topic" mode. Works for any kind of topic input - a single
 * word/phrase, a full paragraph, or an elaborate multi-section instruction
 * like the user might paste in - and in any language/script the topic itself
 * is written in. Asks Gemini to return strict JSON so the caption and image
 * prompt are reliably separated, instead of a single blob of text.
 *
 * IMPORTANT LIMITATION: this call has NO live internet/news access. For
 * evergreen topics (famous quotes, general knowledge, well-known public
 * figures' established history) the model's training knowledge covers this
 * well. For anything requiring TODAY's specific news, it cannot verify
 * current facts and may produce inaccurate or outdated "current events" -
 * there is no live grounding here.
 */
async function generatePostContent(topic, { retries, avoidList } = {}) {
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

  const resp = await retryOn429(
    () =>
      axios.post(
        `${BASE_URL}/models/${env.googleAi.geminiModel}:generateContent`,
        { contents: [{ parts: [{ text: prompt }] }] },
        { params: { key: env.googleAi.geminiApiKey }, timeout: 60000 }
      ),
    { label: 'Gemini post content', retries }
  );

  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini did not return post content');

  // Robust JSON extraction: grab everything between the first { and the last }
  // rather than only stripping code fences, since the model sometimes adds
  // commentary or formatting around the JSON that fence-stripping alone misses.
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(`Gemini response did not contain valid JSON: ${text.slice(0, 200)}`);
  }
  const jsonSlice = text.slice(firstBrace, lastBrace + 1);

  let parsed;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch (parseErr) {
    throw new Error(`Failed to parse Gemini JSON response: ${parseErr.message} - raw: ${jsonSlice.slice(0, 200)}`);
  }
  if (!parsed.caption || !parsed.imagePrompt) throw new Error('Gemini response missing caption or imagePrompt');
  return { caption: parsed.caption.trim(), imagePrompt: parsed.imagePrompt.trim() };
}

/**
 * Rewrites a video's original title/description (any language) into a catchy
 * English title + matching English hashtags. Used by both the TikTok
 * Downloader and the Video Editor's "Regenerate title" option.
 */
async function regenerateTitleAndHashtags(originalTitle, originalDescription, { retries = 2 } = {}) {
  const prompt = `You are rewriting a short video's title and hashtags for social media reposting.

ORIGINAL TITLE: "${originalTitle || ''}"
ORIGINAL DESCRIPTION: "${originalDescription || ''}"

The original may be in ANY language or script. Write a catchy, engaging title IN ENGLISH that captures the same meaning/topic (translate/adapt it, don't just transliterate), and matching relevant English hashtags.

Respond with STRICT JSON only (no markdown fences, no commentary before or after), with exactly these two keys:
{
  "title": "<catchy English title, under 100 characters>",
  "hashtags": "<5-8 relevant English hashtags, space separated, each starting with #>"
}`;

  const resp = await retryOn429(
    () =>
      axios.post(
        `${BASE_URL}/models/${env.googleAi.geminiModel}:generateContent`,
        { contents: [{ parts: [{ text: prompt }] }] },
        { params: { key: env.googleAi.geminiApiKey }, timeout: 60000 }
      ),
    { label: 'Gemini title/hashtags', retries }
  );

  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini did not return title/hashtags');

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(`Gemini response did not contain valid JSON: ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
  if (!parsed.title) throw new Error('Gemini response missing title');
  return { title: parsed.title.trim(), hashtags: (parsed.hashtags || '').trim() };
}

module.exports = { writeScript, generateImage, generateCaption, generatePostContent, regenerateTitleAndHashtags, generateReactionScript };

/**
 * Generates a scene-by-scene plan for the Video Editor's "News Reaction"
 * mode: alternates short bursts of the *original* source clip with narrated
 * still-image scenes (AI-generated or a real frame pulled from the source -
 * the model picks per scene), each with its own spoken narration line.
 *
 * Keeping "clip" bursts short and always narrating over them is what keeps
 * this meaningfully different from a straight repost - see the same note in
 * utils.autoHighlight.js. This reduces automated fingerprint-match /
 * straight-repost risk; it does NOT make reposting someone else's footage
 * legal on its own.
 */
async function generateReactionScript(sourceTitle, sourceDescription, totalDurationSeconds, { narrationLanguage = 'english', retries = 3 } = {}) {
  const prompt = `You are building a scene-by-scene plan for a short "news reaction / explainer" video that reacts to and explains an existing news video, in the style of a commentary/analysis channel.

SOURCE VIDEO TITLE: "${sourceTitle || ''}"
SOURCE VIDEO DESCRIPTION: "${sourceDescription || ''}"
SOURCE VIDEO LENGTH: ${Math.round(totalDurationSeconds)} seconds
NARRATION LANGUAGE: ${narrationLanguage}

Plan 5 to 10 short scenes that alternate between:
- "clip": a 3-5 second burst of the ORIGINAL source video. Use this ONLY for the single most important/newsworthy moments. Keep the total time spent on "clip" scenes well under half of the whole video.
- "image": a still image while the narrator explains/reacts. For each "image" scene, decide "imageSource":
  - "ai": a generated illustration/graphic - use for reactions, context, or abstract points
  - "real_frame": an actual still frame pulled from the source video at a given timestamp - use when a real face/moment should be shown without playing video motion

Every scene needs a short spoken "narration" line (natural spoken style, 1-2 sentences, in ${narrationLanguage}) that explains or reacts to that moment. The narration is what actually plays as audio; any original clip audio is only a quiet background layer under it, never the main audio.

Respond with STRICT JSON only (no markdown fences, no commentary before or after), matching exactly this shape:
{
  "scenes": [
    { "type": "clip", "startTime": 12.5, "endTime": 16.5, "narration": "..." },
    { "type": "image", "imageSource": "ai", "imagePrompt": "<description for an AI image generator>", "narration": "..." },
    { "type": "image", "imageSource": "real_frame", "atTime": 42.0, "narration": "..." }
  ]
}
"startTime"/"endTime"/"atTime" must be within [0, ${Math.round(totalDurationSeconds)}] and in chronological order across the scene list.`;

  const resp = await retryOn429(
    () =>
      axios.post(
        `${BASE_URL}/models/${env.googleAi.geminiModel}:generateContent`,
        { contents: [{ parts: [{ text: prompt }] }] },
        { params: { key: env.googleAi.geminiApiKey }, timeout: 120000 }
      ),
    { label: 'Gemini news reaction script', retries }
  );

  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini did not return a reaction script');

  const cleaned = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed.scenes) || parsed.scenes.length === 0) throw new Error('Gemini returned no scenes');
  return parsed;
}

/**
 * Generates a still image from a text prompt using Gemini's own image model
 * (gemini-2.5-flash-image, aka "Nano Banana"). Saves the result as a PNG file.
 * This is a free-tier alternative to paying for Kie.ai image credits.
 */
async function generateImage(prompt, destPath, { retries } = {}) {
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
          { params: { key: env.googleAi.geminiApiKey }, timeout: 120000 } // 2 min cap - fails+retries instead of hanging forever if Google's side stalls
        ),
      { label: 'Gemini image', retries } // retries undefined -> retryOn429's own default (4) applies unchanged
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
