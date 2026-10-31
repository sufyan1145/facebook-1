// Pure helpers for the Multi-voice dub (no network, no ffmpeg) - easy to test.

const SAMPLE_RATE = 24000;

// ---- time / JSON parsing ---------------------------------------------------

// Accepts 12.5, "12.5", "1:05", "01:05.3", "1:02:03".
function parseTime(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const s = String(v == null ? '' : v).trim();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.split(':').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}

// Gemini sometimes wraps JSON in ```json fences even when asked not to.
function parseSegmentsJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let data;
  try { data = JSON.parse(t); } catch (_) {
    const m = t.match(/[\[{][\s\S]*[\]}]/);
    if (!m) throw new Error('The AI did not return JSON');
    data = JSON.parse(m[0]);
  }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.segments) ? data.segments : null;
  if (!list) throw new Error('The AI JSON had no "segments" list');
  return list;
}

// Cleans one chunk's raw segments; times are shifted by the chunk's offset so
// they are relative to the whole video.
function normalizeSegments(raw, { offset = 0, chunkLength = Infinity } = {}) {
  const out = [];
  for (const r of raw || []) {
    if (!r) continue;
    const text = String(r.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    let start = parseTime(r.start);
    let end = parseTime(r.end);
    if (!Number.isFinite(start)) continue;
    start = Math.min(Math.max(start, 0), chunkLength);
    if (!Number.isFinite(end) || end <= start) end = start + Math.max(0.8, text.length * 0.06);
    end = Math.min(end, Math.max(chunkLength, start + 0.5));
    const g = String(r.gender || '').toLowerCase();
    out.push({
      speaker: String(r.speaker || 'S1').trim() || 'S1',
      gender: g.startsWith('f') ? 'female' : g.startsWith('m') ? 'male' : null,
      note: String(r.note || '').trim().slice(0, 80),
      start: round3(start + offset),
      end: round3(end + offset),
      text,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

function round3(n) { return Math.round(n * 1000) / 1000; }

// Joins neighbouring lines of the SAME speaker that are almost back-to-back, so
// the voice speaks them as one natural sentence (and we make fewer TTS calls).
function mergeSegments(segs, { maxGap = 0.5, maxDuration = 10, maxChars = 450 } = {}) {
  const out = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end <= maxGap &&
        s.end - last.start <= maxDuration && (last.text.length + s.text.length + 1) <= maxChars) {
      last.end = Math.max(last.end, s.end);
      last.text = `${last.text} ${s.text}`;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

// ---- speakers -> voices ----------------------------------------------------

// One entry per speaker id: majority gender over all their lines + line count.
function summarizeSpeakers(segs) {
  const map = new Map();
  for (const s of segs) {
    if (!map.has(s.speaker)) map.set(s.speaker, { id: s.speaker, male: 0, female: 0, lines: 0, note: '' });
    const e = map.get(s.speaker);
    e.lines += 1;
    if (s.gender === 'male') e.male += 1;
    if (s.gender === 'female') e.female += 1;
    if (!e.note && s.note) e.note = s.note;
  }
  return [...map.values()].map((e) => ({
    id: e.id, lines: e.lines, note: e.note,
    gender: e.female > e.male ? 'female' : e.male > e.female ? 'male' : null,
  })).sort((a, b) => b.lines - a.lines);
}

// Every speaker gets its own voice from the pool of its gender (the talkative
// ones get the first / most distinct voices). If a speaker's gender is unknown
// the pool with fewer used voices is chosen. More speakers than voices: voices
// are reused round-robin (never an error).
function assignVoices(speakers, pools) {
  const male = (pools.male && pools.male.length) ? pools.male : (pools.female || []);
  const female = (pools.female && pools.female.length) ? pools.female : male;
  if (!male.length) throw new Error('No voices available for this language');
  let usedM = 0; let usedF = 0;
  const map = new Map();
  for (const sp of speakers) {
    let g = sp.gender;
    if (!g) g = usedM <= usedF ? 'male' : 'female';
    if (g === 'female') { map.set(sp.id, { voice: female[usedF % female.length], gender: 'female' }); usedF += 1; }
    else { map.set(sp.id, { voice: male[usedM % male.length], gender: 'male' }); usedM += 1; }
  }
  return map;
}

// ---- placing speech on the timeline ----------------------------------------

// segs: sorted, each { start, end, dur } where dur = length of the spoken clip.
// Each clip starts when the original line started and may run into the gap
// before the next line; if it is still too long it is sped up (max `maxTempo`);
// if even that is not enough it simply runs a little into the next line.
function planPlacement(segs, total, { maxTempo = 1.5, shift = 0, maxDrift = 3 } = {}) {
  const out = [];
  let overruns = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const nextStart = i + 1 < segs.length ? segs[i + 1].start : total;
    const slot = Math.max(s.end - s.start, 0.4);
    const room = Math.max(nextStart - s.start - 0.05, slot);
    const tempo = Math.min(Math.max(s.dur / room, 1), maxTempo);
    const placed = s.dur / tempo;
    if (placed > room + 0.05) overruns += 1;
    let startSec = Math.max(0, s.start - shift);
    // Never let two voices talk over each other: a line that would start while
    // the previous one is still speaking waits for it (up to maxDrift seconds
    // late; beyond that it keeps its own time so the video never drifts).
    const prev = out[out.length - 1];
    if (prev) {
      const prevEnd = prev.startSec + prev.placedDuration + 0.08;
      if (startSec < prevEnd && prevEnd - (s.start - shift) <= maxDrift) startSec = prevEnd;
    }
    if (startSec + placed > total) startSec = Math.max(0, total - placed);
    out.push({ index: i, startSec: round3(startSec), tempo: round3(tempo), placedDuration: round3(placed) });
  }
  return { items: out, overruns };
}

// ---- splitting a long video into parts at silences -------------------------

function parseSilenceDetect(stderrText) {
  const mids = [];
  let start = null;
  for (const line of String(stderrText || '').split('\n')) {
    const a = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (a) { start = parseFloat(a[1]); continue; }
    const b = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (b && start !== null) { mids.push((Math.max(start, 0) + parseFloat(b[1])) / 2); start = null; }
  }
  return mids;
}

function parseSilenceIntervals(stderrText) {
  const out = [];
  let start = null;
  for (const line of String(stderrText || '').split('\n')) {
    const a = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (a) { start = Math.max(parseFloat(a[1]), 0); continue; }
    const b = line.match(/silence_end:\s*(-?[\d.]+)/);
    if (b && start !== null) { out.push({ start, end: parseFloat(b[1]) }); start = null; }
  }
  return out;
}

function nearest(list, t, window) {
  let best = null; let bestD = Infinity;
  for (const x of list) {
    const d = Math.abs(x - t);
    if (d <= window && d < bestD) { best = x; bestD = d; }
  }
  return best;
}

// The AI's timestamps are usually close but can be off by about a second.
// The audio itself knows exactly where speech starts: right after a silence.
// Each line's start is moved to the nearest speech start (and its end to the
// nearest speech end) within `window` seconds. Where no silence is nearby
// (e.g. constant background music) the AI's time is kept as it is.
function snapToSpeech(lines, silences, { window = 1.2, minSilence = 0.25 } = {}) {
  const real = (silences || []).filter((s) => s.end - s.start >= minSilence);
  const onsets = real.map((s) => s.end);
  const offsets = real.map((s) => s.start);
  let prevStart = -Infinity;
  let snapped = 0;
  const out = lines.map((l) => {
    let start = l.start; let end = l.end;
    const o = nearest(onsets, l.start, window);
    if (o !== null && o > prevStart + 0.05) { start = o; snapped += 1; }
    const f = nearest(offsets, l.end, window);
    if (f !== null && f > start + 0.3) end = f;
    if (end <= start) end = l.end > start ? l.end : start + 0.5;
    prevStart = start;
    return { ...l, rawStart: l.start, start: round3(start), end: round3(end) };
  });
  return { lines: out, snapped };
}

// Parts of about `target` seconds; each cut is moved to the quietest nearby
// spot (a silence within +-window) so a sentence is not cut in half.
function planChunks(total, { target = 300, window = 30, silences = [] } = {}) {
  if (total <= target * 1.25) return [{ start: 0, end: total }];
  const n = Math.round(total / target);
  const cuts = [];
  for (let k = 1; k < n; k++) {
    const ideal = (total / n) * k;
    let best = ideal; let bestD = Infinity;
    for (const m of silences) {
      const d = Math.abs(m - ideal);
      if (d <= window && d < bestD) { best = m; bestD = d; }
    }
    cuts.push(round3(best));
  }
  const bounds = [0, ...cuts, total];
  const chunks = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    if (bounds[i + 1] - bounds[i] > 0.5) chunks.push({ start: bounds[i], end: bounds[i + 1] });
  }
  return chunks;
}

// ---- audio buffer helpers --------------------------------------------------

// items: [{ pcm: Int16Array, startSec }] -> one mono Int16Array of `totalSec`.
function mixPcm(items, totalSec, sampleRate = SAMPLE_RATE) {
  const len = Math.ceil(totalSec * sampleRate);
  const out = new Int16Array(len);
  for (const it of items) {
    const at = Math.max(0, Math.round(it.startSec * sampleRate));
    const n = Math.min(it.pcm.length, len - at);
    for (let i = 0; i < n; i++) {
      const v = out[at + i] + it.pcm[i];
      out[at + i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
  }
  return out;
}

function encodeWav(int16, sampleRate = SAMPLE_RATE) {
  const dataBytes = int16.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(int16.buffer, int16.byteOffset, dataBytes).copy(buf, 44);
  return buf;
}

// Original-audio volume as a fraction (0 = off, 0.5 = half volume). Anything
// else is clamped into 0..0.5.
function clampOriginalVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 0.5);
}

// ---- cutting long silences + sound-effect cues -----------------------------

// spans: [{start,end}] where somebody is talking (original line or dubbed
// line, whichever is longer). A "silence" is any stretch between spans.
// Silences longer than `minSilence` are shortened to `keep` seconds (half kept
// before, half after the cut); shorter ones are never touched, and nothing
// inside a dialogue span is ever cut. Returns the REMOVED ranges.
function planSilenceCuts(spans, total, { minSilence = 5, keep = 3 } = {}) {
  const clean = (spans || [])
    .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => ({ start: Math.max(0, s.start), end: Math.min(total, s.end) }))
    .sort((a, b) => a.start - b.start);
  if (!clean.length) return [];
  const merged = [];
  for (const s of clean) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push({ ...s });
  }
  const k = Math.min(Math.max(keep, 0), minSilence);
  const half = k / 2;
  const cuts = [];
  const gap = (a, b, head, tail) => {
    if (b - a <= minSilence) return;
    const from = head ? a : a + half;
    const to = tail ? b : b - half;
    if (head && tail) return;
    if (to - from > 0.05) cuts.push({ start: round3(from), end: round3(to) });
  };
  gap(0, merged[0].start, true, false);
  for (let i = 0; i + 1 < merged.length; i++) gap(merged[i].end, merged[i + 1].start, false, false);
  gap(merged[merged.length - 1].end, total, false, true);
  return cuts;
}

function keepSegments(cuts, total) {
  const out = [];
  let pos = 0;
  for (const c of cuts) {
    if (c.start - pos > 0.05) out.push({ start: round3(pos), end: round3(c.start) });
    pos = Math.max(pos, c.end);
  }
  if (total - pos > 0.05) out.push({ start: round3(pos), end: round3(total) });
  return out;
}

// Time in the original -> time in the shortened video.
function mapTime(keep, t) {
  let acc = 0;
  for (const k of keep) {
    if (t < k.start) return round3(acc);
    if (t <= k.end) return round3(acc + (t - k.start));
    acc += k.end - k.start;
  }
  return round3(acc);
}

// Where a sound effect + zoom-in happens: when someone starts talking after a
// real pause, or when the speaker changes (a new "beat" of the scene), never
// closer together than `minSpacing`. lines: [{start, speaker}] sorted.
function planSfxCues(lines, total, { minPause = 1.2, minSpacing = 5, max = 80 } = {}) {
  const cues = [];
  let prevEnd = 0; let prevSpeaker = null; let last = -Infinity;
  for (const l of lines) {
    const pause = l.start - prevEnd;
    const change = prevSpeaker !== null && l.speaker !== prevSpeaker;
    if ((pause >= minPause || change) && l.start - last >= minSpacing && l.start < total - 0.6 && cues.length < max) {
      cues.push(round3(l.start)); last = l.start;
    }
    prevEnd = Math.max(prevEnd, l.end); prevSpeaker = l.speaker;
  }
  return cues;
}

module.exports = {
  planSilenceCuts, keepSegments, mapTime, planSfxCues,
  SAMPLE_RATE, parseTime, parseSegmentsJson, normalizeSegments, mergeSegments, summarizeSpeakers,
  assignVoices, planPlacement, parseSilenceDetect, parseSilenceIntervals, snapToSpeech, planChunks, mixPcm, encodeWav, clampOriginalVolume,
};
