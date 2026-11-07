/**
 * Writes one complete blog article with Gemini (Vertex AI) and returns it as
 * structured data + ready-to-publish HTML.
 *
 * Images are NOT made here: the article only says WHERE a picture belongs and
 * what it should show (English prompt); services.websiteWorker.js generates
 * them with Nano Banana and puts the final <img> tags in.
 *
 * Self-contained on purpose (own Vertex auth) - no existing service changes.
 */
const axios = require('axios');
const { GoogleAuth } = require('google-auth-library');
const env = require('./config.env');
const logger = require('./utils.logger');
const { retryOn429 } = require('./utils.retry');

const LENGTH_WORDS = { short: '600-800', medium: '1100-1400', long: '1800-2300' };
const MAX_IMAGES = 8;

let authClient = null;
function getAuth() {
  if (!authClient) {
    if (!env.vertexAi.credentialsBase64) throw new Error('VERTEX_CREDENTIALS_BASE64 is not set');
    const credentials = JSON.parse(Buffer.from(env.vertexAi.credentialsBase64, 'base64').toString('utf8'));
    authClient = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  return authClient;
}
async function getAccessToken() {
  const t = await (await getAuth().getClient()).getAccessToken();
  return typeof t === 'string' ? t : t.token;
}
function baseUrl() {
  const loc = (env.vertexAi.location || 'us-central1').trim().toLowerCase();
  const host = loc === 'global' ? 'aiplatform.googleapis.com'
    : (loc === 'us' || loc === 'eu') ? `aiplatform.${loc}.rep.googleapis.com`
    : `${loc}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${env.vertexAi.projectId}/locations/${loc}/publishers/google/models`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Everything except [[...]] markers is plain text from the AI; allow only
// **bold** / *italic* so nothing else can slip into the page.
function inline(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>');
}

function parseJson(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('The AI did not return JSON');
  return JSON.parse(t.slice(a, b + 1));
}

function buildPrompt({ topic, language, length, imageCount, avoidTitles }) {
  const avoid = avoidTitles && avoidTitles.length
    ? `\nALREADY PUBLISHED on this website for this topic (choose a clearly DIFFERENT angle / subtopic, never repeat these):\n${avoidTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n`
    : '';
  const lang = !language || language === 'auto'
    ? 'the same language and script the topic is written in'
    : language === 'urdu' ? 'Urdu (written in Urdu script)'
    : language.charAt(0).toUpperCase() + language.slice(1);
  return `You are an experienced blog writer and SEO editor. Write ONE complete, original, useful article for a website.

TOPIC / INSTRUCTIONS (may be one word or a detailed brief; follow it closely):
"""
${topic}
"""
${avoid}
Requirements:
- Language: ${lang}. Everything in the article (title, headings, text, tags) uses that language, except "imagePrompt" values which are ALWAYS English.
- Length: about ${LENGTH_WORDS[length] || LENGTH_WORDS.medium} words in total.
- Structure: a catchy, honest title (max 70 characters); a short intro; 4-8 sections with clear headings; a conclusion. Natural, human tone, no filler, no repeated sentences.
- Do not invent statistics, quotes, dates, prices or "recent news" you are not certain about. If the topic needs live facts, stay evergreen and general.
- Write for readers first, search engines second (keywords used naturally, never stuffed).
- "metaDescription": one sentence, max 155 characters.
- "tags": 3-6 short tags/labels.
- Images: exactly ${imageCount} picture(s) that would make the article better. For each give "afterSection" (0 = right after the intro, 1 = after the first section, ...), "alt" (short alt text in the article language) and "imagePrompt" (a detailed, realistic, English image-generation prompt; NO text, letters, logos or watermarks inside the picture).${imageCount === 0 ? ' (So "images" is an empty list.)' : ''}

Respond with STRICT JSON only, exactly this shape (no markdown fences, no commentary):
{
  "title": "...",
  "metaDescription": "...",
  "tags": ["..."],
  "intro": ["paragraph", "paragraph"],
  "sections": [ { "heading": "...", "paragraphs": ["..."], "bullets": ["optional list item"] } ],
  "conclusion": ["paragraph"],
  "images": [ { "afterSection": 0, "alt": "...", "imagePrompt": "..." } ]
}
You may use **bold** and *italic* inside paragraphs. No HTML.`;
}

function cleanList(v, max = 60) {
  return (Array.isArray(v) ? v : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, max);
}

// Validates + normalises the AI's JSON (never trust the shape).
function normalizeArticle(raw, imageCount) {
  const title = String(raw.title || '').trim().slice(0, 150);
  if (!title) throw new Error('The AI article had no title');
  const sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .map((s) => ({
      heading: String((s && s.heading) || '').trim(),
      paragraphs: cleanList(s && s.paragraphs),
      bullets: cleanList(s && s.bullets, 20),
    }))
    .filter((s) => s.heading && (s.paragraphs.length || s.bullets.length));
  const intro = cleanList(raw.intro);
  const conclusion = cleanList(raw.conclusion);
  const words = [...intro, ...conclusion, ...sections.flatMap((s) => [...s.paragraphs, ...s.bullets])].join(' ').split(/\s+/).filter(Boolean).length;
  if (sections.length < 2 || words < 150) throw new Error('The AI article was too short or incomplete');
  const images = (Array.isArray(raw.images) ? raw.images : [])
    .map((im) => ({
      afterSection: Math.min(Math.max(parseInt(im && im.afterSection, 10) || 0, 0), sections.length),
      alt: String((im && im.alt) || title).trim().slice(0, 150),
      imagePrompt: String((im && im.imagePrompt) || '').trim(),
    }))
    .filter((im) => im.imagePrompt)
    .slice(0, Math.min(imageCount, MAX_IMAGES));
  return {
    title,
    metaDescription: String(raw.metaDescription || '').trim().slice(0, 200),
    tags: cleanList(raw.tags, 8).map((t) => t.replace(/^#/, '').slice(0, 40)),
    intro, sections, conclusion, images, words,
  };
}

// Article + { index -> final image URL } -> HTML. `imageUrls[i]` may be missing
// (that picture failed): it is simply left out.
function renderHtml(article, imageUrls = []) {
  const figure = (i) => {
    const url = imageUrls[i];
    if (!url) return '';
    const alt = escapeHtml(article.images[i].alt);
    return `<figure style="margin:1.5em 0;text-align:center;"><img src="${escapeHtml(url)}" alt="${alt}" style="max-width:100%;height:auto;border-radius:6px;" /></figure>\n`;
  };
  const imagesAfter = (n) => article.images.map((im, i) => (im.afterSection === n ? figure(i) : '')).join('');
  const paras = (list) => list.map((p) => `<p>${inline(p)}</p>`).join('\n');
  let html = paras(article.intro) + '\n' + imagesAfter(0);
  article.sections.forEach((s, idx) => {
    html += `<h2>${inline(s.heading)}</h2>\n${paras(s.paragraphs)}\n`;
    if (s.bullets.length) html += `<ul>\n${s.bullets.map((b) => `<li>${inline(b)}</li>`).join('\n')}\n</ul>\n`;
    html += imagesAfter(idx + 1);
  });
  if (article.conclusion.length) html += paras(article.conclusion) + '\n';
  const rtl = /[؀-ۿݐ-ݿ]/.test(article.title + article.intro.join(' '));
  return rtl ? `<div dir="rtl" style="text-align:right;">\n${html}</div>` : html;
}

async function writeArticle({ topic, language = 'auto', length = 'medium', imageCount = 3, avoidTitles = [] }) {
  const n = Math.min(Math.max(parseInt(imageCount, 10) || 0, 0), MAX_IMAGES);
  const prompt = buildPrompt({ topic, language, length, imageCount: n, avoidTitles });
  const token = await getAccessToken();
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await retryOn429(
        () => axios.post(
          `${baseUrl()}/${env.vertexAi.scriptModel}:generateContent`,
          { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 16000, temperature: 0.8 } },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 180000 }
        ),
        { label: 'Vertex article writing' }
      );
      const text = (resp.data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
      if (!text) throw new Error('Vertex did not return an article');
      return normalizeArticle(parseJson(text), n);
    } catch (err) {
      lastErr = err.response?.data?.error?.message ? new Error(err.response.data.error.message) : err;
      logger.warn(`[website-article] attempt ${attempt} failed: ${lastErr.message}`);
    }
  }
  throw lastErr;
}

module.exports = { writeArticle, renderHtml, normalizeArticle, buildPrompt, parseJson, MAX_IMAGES };
