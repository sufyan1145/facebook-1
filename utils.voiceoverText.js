// Pure helpers for the Voice Over tool (no network / ffmpeg) - easy to test.

const MAX_MINUTES = 100;
// Speaking speed used for the length estimate: ~15 characters per second at
// normal speed (about 150-170 words a minute in most languages).
const CHARS_PER_MINUTE = 900;
const MAX_CHUNK_CHARS = 900; // safe for the TTS request limit even for 2-3 bytes/char scripts
const SENTENCE_END = /([.!?؟۔।！？。]+["'”’)\]]*)(\s+)/g;

function estimateMinutes(charCount, rate = 1) {
  const r = Math.min(Math.max(Number(rate) || 1, 0.25), 2);
  return Math.round((charCount / (CHARS_PER_MINUTE * r)) * 10) / 10;
}

function maxCharsFor(rate = 1) {
  const r = Math.min(Math.max(Number(rate) || 1, 0.25), 2);
  return Math.floor(MAX_MINUTES * CHARS_PER_MINUTE * r);
}

function normalizeText(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// A single sentence longer than max is cut at the nearest comma / space.
function splitLong(sentence, max) {
  const out = [];
  let rest = sentence.trim();
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf('، ', max), rest.lastIndexOf(', ', max), rest.lastIndexOf('; ', max));
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.4) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Text -> ordered chunks [{ text, pauseAfter }] of at most `max` characters,
 * always ending on a sentence boundary where possible. `pauseAfter` is the
 * silence (seconds) added after the chunk: a longer one at paragraph ends.
 */
function splitIntoChunks(text, max = MAX_CHUNK_CHARS) {
  const clean = normalizeText(text);
  if (!clean) return [];
  const paragraphs = clean.split(/\n\s*\n/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
  const chunks = [];
  paragraphs.forEach((para) => {
    const sentences = [];
    let last = 0; let m;
    SENTENCE_END.lastIndex = 0;
    while ((m = SENTENCE_END.exec(para)) !== null) {
      sentences.push(para.slice(last, m.index + m[1].length));
      last = m.index + m[0].length;
    }
    if (last < para.length) sentences.push(para.slice(last));
    let cur = '';
    const flush = () => { if (cur.trim()) chunks.push({ text: cur.trim(), pauseAfter: 0.12 }); cur = ''; };
    for (const s of sentences) {
      for (const piece of (s.length > max ? splitLong(s, max) : [s])) {
        if (cur && (cur.length + piece.length + 1) > max) flush();
        cur = cur ? `${cur} ${piece}` : piece;
      }
    }
    flush();
    if (chunks.length) chunks[chunks.length - 1].pauseAfter = 0.55; // paragraph break
  });
  if (chunks.length) chunks[chunks.length - 1].pauseAfter = 0;
  return chunks;
}

// ---- voices -----------------------------------------------------------------
const FAMILY_ORDER = ['Gemini', 'Chirp3-HD', 'Chirp-HD', 'Studio', 'Neural2', 'Polyglot', 'News', 'Casual', 'Wavenet', 'Standard'];

function voiceFamily(name) {
  const n = String(name || '');
  for (const f of FAMILY_ORDER) if (n.includes(`-${f}`)) return f;
  return 'Other';
}

// ---- Gemini TTS (Cloud Text-to-Speech, its `prompt` field = style / emotion) --------
// Genders are from Google's Gemini-TTS voice table. These voices are not in
// voices.list, so they are added here. They are the only voices that take an
// instruction like "warm, emotional, native Pakistani accent", and the only
// ones with Urdu (Pakistan) ur-PK and Punjabi in the Gemini family.
const GEMINI_VOICES = {
  Achernar: 'F', Achird: 'M', Algenib: 'M', Algieba: 'M', Alnilam: 'M', Aoede: 'F', Autonoe: 'F', Callirrhoe: 'F',
  Charon: 'M', Despina: 'F', Enceladus: 'M', Erinome: 'F', Fenrir: 'M', Gacrux: 'F', Iapetus: 'M', Kore: 'F',
  Laomedeia: 'F', Leda: 'F', Orus: 'M', Pulcherrima: 'F', Puck: 'M', Rasalgethi: 'M', Sadachbia: 'M',
  Sadaltager: 'M', Schedar: 'M', Sulafat: 'F', Umbriel: 'M', Vindemiatrix: 'F', Zephyr: 'F', Zubenelgenubi: 'M',
};
const GEMINI_LANGS = ['ur-PK', 'pa-IN', 'hi-IN', 'en-US', 'en-IN'];
const isGeminiVoice = (name) => Object.prototype.hasOwnProperty.call(GEMINI_VOICES, String(name || ''));

function geminiVoiceEntries() {
  const out = [];
  for (const code of GEMINI_LANGS) {
    for (const [name, g] of Object.entries(GEMINI_VOICES)) {
      out.push({ name, languageCode: code, gender: g === 'M' ? 'male' : 'female', family: 'Gemini', short: name, sampleRate: 24000 });
    }
  }
  return out;
}

const STYLES = {
  natural: { label: 'Natural storyteller', text: 'a natural, expressive storyteller with lively, varied intonation' },
  warm: { label: 'Warm & emotional', text: 'warm, heartfelt and emotional, with real feeling in the voice' },
  excited: { label: 'Excited & energetic', text: 'excited, energetic and enthusiastic' },
  calm: { label: 'Calm & soothing', text: 'calm, soft and soothing, unhurried' },
  serious: { label: 'Serious / news', text: 'serious, confident and authoritative, like a news presenter' },
  dramatic: { label: 'Dramatic & gripping', text: 'dramatic and gripping, with strong emotion, suspense and emphasis on key words' },
  sad: { label: 'Sad & heavy', text: 'sad, heavy-hearted and emotional, slower, with a trembling softness' },
};
const LANG_NAMES = { ur: 'Urdu', pa: 'Punjabi', hi: 'Hindi', en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', tr: 'Turkish', id: 'Indonesian', vi: 'Vietnamese' };

function normalizeStyle(key, custom) {
  return { key: STYLES[key] ? key : 'natural', custom: String(custom || '').replace(/\s+/g, ' ').trim().slice(0, 300) };
}

// English instruction sent in Gemini's `prompt` field (it is never spoken).
function buildStylePrompt(languageCode, style) {
  const st = normalizeStyle(style && style.key, style && style.custom);
  const base = String(languageCode || 'en').split('-')[0].toLowerCase();
  const lang = LANG_NAMES[base] || 'the given language';
  let accent = '';
  if (base === 'ur') accent = ' Speak as a native Pakistani Urdu speaker (Lahore / Karachi style) with authentic Urdu pronunciation, never with an English or Indian-English accent.';
  else if (base === 'pa') accent = ' Speak as a native Punjabi speaker with authentic Punjabi pronunciation, never with an English accent.';
  else if (base === 'hi') accent = ' Speak as a native Hindi speaker with authentic pronunciation, never with an English accent.';
  return `Read the following ${lang} text aloud in a voice that is ${STYLES[st.key].text}.${accent}`
    + ' Show genuine emotion that follows the meaning of each sentence, with natural pauses, and keep the same voice and energy throughout.'
    + (st.custom ? ` Extra direction: ${st.custom}` : '');
}

// ---- script check: Roman Urdu read by an Urdu voice sounds like an Englishman ------------
const RE = {
  latin: /[A-Za-z]/g,
  arabic: /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g,
  gurmukhi: /[਀-੿]/g,
  devanagari: /[ऀ-ॿ]/g,
};
const LATIN_LANGS = new Set(['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'tr', 'id', 'vi']);
const NATIVE = { ur: 'arabic', pa: 'gurmukhi', hi: 'devanagari' };
const SCRIPT_NAME = { ur: 'Urdu', pa: 'Gurmukhi', hi: 'Devanagari' };

function scriptStats(text) {
  const t = String(text || ''); const out = {};
  for (const k of Object.keys(RE)) out[k] = (t.match(RE[k]) || []).length;
  out.total = out.latin + out.arabic + out.gurmukhi + out.devanagari;
  return out;
}

/** null = fine; otherwise { code, message, canConvert }. */
function scriptProblem(languageCode, text) {
  const base = String(languageCode || '').split('-')[0].toLowerCase();
  const native = NATIVE[base];
  const s = scriptStats(text);
  if (!native) {
    // e.g. an English / Spanish voice given Urdu, Punjabi or Hindi letters: it would read them like a foreigner
    if (!LATIN_LANGS.has(base) || s.total < 8) return null;
    const other = s.arabic + s.gurmukhi + s.devanagari;
    if (other / s.total < 0.5) return null;
    return { code: 'wrongvoice', canConvert: false, message: `The text is in Urdu / Punjabi / Hindi letters, but the selected voice speaks ${LANG_NAMES[base] || base}. Choose a voice of the text's own language (for Urdu: "Urdu (Pakistan)" Gemini voices) in the Language list.` };
  }
  if (s.total < 8 || s[native] / s.total >= 0.5) return null;
  const want = SCRIPT_NAME[base];
  if (s.latin / s.total >= 0.5) {
    return { code: 'roman', canConvert: true, message: `This text is written in English letters (Roman), but this ${LANG_NAMES[base]} voice needs ${want} script. Roman text is read like an English speaker. Click "Convert to ${want} script", check the result, then create the voice-over.` };
  }
  if (base === 'pa' && s.arabic / s.total >= 0.5) {
    return { code: 'shahmukhi', canConvert: true, message: 'This Punjabi is in Shahmukhi (Urdu-style letters). Google Punjabi voices read Gurmukhi only. Click "Convert to Gurmukhi script", or keep the Urdu letters and pick an Urdu voice.' };
  }
  return { code: 'other', canConvert: true, message: `This text is not in ${want} script, which this voice needs.` };
}

// Raw Google voices.list -> flat list with a TRUSTED gender (Google's own
// ssmlGender, never guessed from the name) and one entry per locale.
function normalizeVoices(raw) {
  const out = [];
  for (const v of raw || []) {
    const g = String(v.ssmlGender || '').toUpperCase();
    const gender = g === 'MALE' ? 'male' : g === 'FEMALE' ? 'female' : null;
    if (!gender) continue; // unknown gender: not offered, so a male / female promise can never be broken
    const family = voiceFamily(v.name);
    const short = String(v.name).split('-').pop();
    for (const code of v.languageCodes || []) {
      out.push({ name: v.name, languageCode: code, gender, family, short, sampleRate: v.naturalSampleRateHertz || 24000 });
    }
  }
  const seen = new Set(out.map((v) => `${v.name}|${v.languageCode}`));
  for (const g of geminiVoiceEntries()) if (!seen.has(`${g.name}|${g.languageCode}`)) out.push(g);
  const rank = (f) => { const i = FAMILY_ORDER.indexOf(f); return i === -1 ? 99 : i; };
  return out.sort((a, b) => a.languageCode.localeCompare(b.languageCode) || rank(a.family) - rank(b.family) || a.name.localeCompare(b.name));
}

// "Voice character" on top of a voice: a small pitch change in semitones.
// Limited to +-3 so a male voice always stays male and a female voice female.
function clampPitch(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(Math.max(n, -3), 3) * 2) / 2;
}
function clampRate(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.min(Math.max(n, 0.5), 1.8) * 20) / 20;
}

module.exports = {
  MAX_MINUTES, CHARS_PER_MINUTE, MAX_CHUNK_CHARS, estimateMinutes, maxCharsFor, normalizeText,
  splitIntoChunks, normalizeVoices, voiceFamily, clampPitch, clampRate,
  GEMINI_VOICES, GEMINI_LANGS, STYLES, isGeminiVoice, normalizeStyle, buildStylePrompt, scriptStats, scriptProblem,
};
