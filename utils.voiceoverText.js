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
const FAMILY_ORDER = ['Chirp3-HD', 'Chirp-HD', 'Studio', 'Neural2', 'Polyglot', 'News', 'Casual', 'Wavenet', 'Standard'];

function voiceFamily(name) {
  const n = String(name || '');
  for (const f of FAMILY_ORDER) if (n.includes(`-${f}`)) return f;
  return 'Other';
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
};
