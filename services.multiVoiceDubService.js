/**
 * Multi-voice dub: every speaker in a video gets their own voice (male voices
 * for men, female voices for women) speaking the translation at the moment the
 * original line was spoken, plus an optional quiet copy of the original audio.
 *
 *   1. audio -> parts of ~5 min (cut at silences)
 *   2. Gemini (Vertex): who speaks when + translated text, per part
 *      (already-seen speakers are passed to the next part so ids stay stable)
 *   3. voices: each speaker -> a distinct Chirp3-HD voice of the right gender
 *   4. Cloud TTS per line -> placed on the original timeline (sped up a little
 *      when the translation is longer than the original line)
 *   5. one dub track as long as the video
 *
 * mixOriginalUnder() then (optionally, for ANY dub) blends the original audio
 * in at a chosen volume.
 *
 * Self-contained on purpose (own Vertex auth / TTS calls): no existing service
 * file has to change.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const { GoogleAuth } = require('google-auth-library');
const env = require('./config.env');
const logger = require('./utils.logger');
const { retryOn429 } = require('./utils.retry');
const tl = require('./utils.dubTimeline');

// Same locales as the single-voice dub (services.vertexAiService.js).
const TTS_LANGUAGE_CODES = {
  english: 'en-US', urdu: 'ur-IN', hindi: 'hi-IN', chinese: 'cmn-CN', spanish: 'es-ES', french: 'fr-FR',
  italian: 'it-IT', portuguese: 'pt-BR', japanese: 'ja-JP', german: 'de-DE', arabic: 'ar-XA', russian: 'ru-RU',
  korean: 'ko-KR', turkish: 'tr-TR', vietnamese: 'vi-VN', indonesian: 'id-ID', dutch: 'nl-NL', polish: 'pl-PL',
  thai: 'th-TH', bengali: 'bn-IN',
};
const LANGUAGE_LABEL = { chinese: 'Chinese (Mandarin)', urdu: 'Urdu (written in Urdu script)', bengali: 'Bengali' };

// Voices already used (and proven) by this app; used first, and as the
// fallback if the voice list cannot be fetched.
const KNOWN_MALE = ['Charon', 'Iapetus', 'Puck'];
const KNOWN_FEMALE = ['Kore', 'Zephyr'];

const MAX_VIDEO_SECONDS = 60 * 60;       // Int16 mono @24kHz = ~170MB at 1h
const TTS_CONCURRENCY = 3;
const MAX_TTS_FAIL_RATIO = 0.3;

// ---- Google auth / endpoints ----------------------------------------------
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

// ---- ffmpeg helpers --------------------------------------------------------
async function ff(args, opts = {}) {
  try {
    return await execFileAsync('ffmpeg', ['-y', '-hide_banner', '-nostats', ...args], { timeout: 0, maxBuffer: 1024 * 1024 * 50, ...opts });
  } catch (err) {
    const stderr = (err.stderr || '').toString().trim();
    if (stderr) err.message = `${err.message}\nffmpeg stderr: ${stderr.slice(-800)}`;
    throw err;
  }
}

async function mediaDuration(file) {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const d = parseFloat(String(stdout).trim());
  if (!d || Number.isNaN(d)) throw new Error(`Could not read the length of ${path.basename(file)}`);
  return d;
}

async function hasAudioStream(file) {
  try {
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]);
    return String(stdout).trim().length > 0;
  } catch (_) { return false; }
}

async function detectSilences(audioPath) {
  try {
    const { stderr } = await ff(['-i', audioPath, '-af', 'silencedetect=noise=-35dB:d=0.25', '-f', 'null', '-'], { encoding: 'utf8' });
    return tl.parseSilenceIntervals(stderr);
  } catch (_) { return []; }
}

// ---- Gemini: who speaks when, translated ----------------------------------
const SEGMENT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    segments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          speaker: { type: 'STRING' },
          gender: { type: 'STRING' },
          note: { type: 'STRING' },
          start: { type: 'NUMBER' },
          end: { type: 'NUMBER' },
          text: { type: 'STRING' },
        },
        required: ['speaker', 'gender', 'start', 'end', 'text'],
      },
    },
  },
  required: ['segments'],
};

function buildPrompt(targetLabel, sourceLanguage, known) {
  const src = sourceLanguage && sourceLanguage.trim() ? `The speech is in ${sourceLanguage.trim()}.` : 'Auto-detect the spoken language(s).';
  const knownText = known.length
    ? `Speakers already identified in earlier parts of this video (reuse the SAME id when the voice is the same person; use a new id like S${known.length + 1} only for a clearly new voice):\n` +
      known.map((k) => `- ${k.id}: ${k.gender || 'unknown gender'}${k.note ? `, ${k.note}` : ''}`).join('\n')
    : 'Name speakers S1, S2, S3... in the order they first speak.';
  return `You are preparing a dub. Listen to the attached audio (one part of a longer video; time 0 = the start of THIS audio). ${src}

Find every spoken line and, for each one, give:
- speaker: a stable id for the person speaking.
- gender: "male" or "female" - your best judgement from the voice.
- note: 3-6 words describing the voice (e.g. "adult man, deep, calm") - only needed the first time a speaker appears.
- start, end: seconds from the start of THIS audio when the line starts and ends (numbers like 12.4).
- text: the line translated into ${targetLabel}, natural spoken style (as a native ${targetLabel} speaker would say it), nothing else - no notes, no quotes, no speaker names.

${knownText}

Rules: start a new item whenever the speaker changes. Keep lines in time order. Skip music, noise and silence. Never invent speech that is not in the audio. If nobody speaks, return an empty list.
Return ONLY JSON: {"segments":[{"speaker":"S1","gender":"male","note":"...","start":0.0,"end":0.0,"text":"..."}]}`;
}

async function geminiSegments(audioPath, { targetLabel, sourceLanguage, known }) {
  const audioBase64 = fs.readFileSync(audioPath).toString('base64');
  const body = (withSchema) => ({
    contents: [{ role: 'user', parts: [{ text: buildPrompt(targetLabel, sourceLanguage, known) }, { inlineData: { mimeType: 'audio/mp3', data: audioBase64 } }] }],
    generationConfig: withSchema
      ? { temperature: 0.2, responseMimeType: 'application/json', responseSchema: SEGMENT_SCHEMA }
      : { temperature: 0.2, responseMimeType: 'application/json' },
  });
  const call = (withSchema) => retryOn429(async () => {
    const token = await getAccessToken();
    return axios.post(`${baseUrl()}/${env.vertexAi.scriptModel}:generateContent`, body(withSchema), {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 300000,
    });
  }, { label: 'Vertex dub segments', retries: 3 });

  let resp;
  try {
    try { resp = await call(true); } catch (err) {
      // Some models reject a response schema - the prompt alone is enough.
      if (err.response?.status === 400) resp = await call(false); else throw err;
    }
  } catch (err) {
    const detail = err.response?.data;
    logger.error(`[multivoice-dub] Gemini FAILED: status=${err.response?.status} detail=${JSON.stringify(detail)}`);
    throw new Error(detail?.error?.message || err.message);
  }
  const candidate = resp.data.candidates?.[0];
  const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) return []; // nothing spoken / blocked part -> no lines for this part
  try { return tl.parseSegmentsJson(text); } catch (err) {
    logger.warn(`[multivoice-dub] could not parse a part's JSON (${err.message}); skipping that part`);
    return [];
  }
}

// ---- Voices ----------------------------------------------------------------
const voiceCache = new Map();
async function voicePools(languageCode) {
  if (voiceCache.has(languageCode)) return voiceCache.get(languageCode);
  let pools = { male: [...KNOWN_MALE], female: [...KNOWN_FEMALE] };
  try {
    const token = await getAccessToken();
    const resp = await axios.get('https://texttospeech.googleapis.com/v1/voices', {
      params: { languageCode }, headers: { Authorization: `Bearer ${token}` }, timeout: 30000,
    });
    const male = []; const female = [];
    for (const v of resp.data.voices || []) {
      const m = String(v.name || '').match(/Chirp3-HD-(\w+)$/);
      if (!m) continue;
      (v.ssmlGender === 'FEMALE' ? female : v.ssmlGender === 'MALE' ? male : []).push(m[1]);
    }
    const order = (list, known) => [...known.filter((k) => list.includes(k)), ...list.filter((x) => !known.includes(x)).sort()];
    if (male.length && female.length) pools = { male: order(male, KNOWN_MALE), female: order(female, KNOWN_FEMALE) };
  } catch (err) {
    logger.warn(`[multivoice-dub] could not list voices for ${languageCode} (${err.message}); using the built-in voices`);
  }
  voiceCache.set(languageCode, pools);
  return pools;
}

// ---- TTS -> PCM ------------------------------------------------------------
async function synthesize(text, destMp3, voice, languageCode) {
  const name = `${languageCode}-Chirp3-HD-${voice}`;
  let resp;
  try {
    resp = await retryOn429(async () => {
      const token = await getAccessToken();
      return axios.post('https://texttospeech.googleapis.com/v1/text:synthesize', {
        input: { text }, voice: { languageCode, name }, audioConfig: { audioEncoding: 'MP3' },
      }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 60000 });
    }, { label: 'Cloud TTS (multi-voice)', retries: 3 });
  } catch (err) {
    throw new Error(err.response?.data?.error?.message || err.message);
  }
  if (!resp.data.audioContent) throw new Error('Cloud Text-to-Speech returned no audio');
  fs.writeFileSync(destMp3, Buffer.from(resp.data.audioContent, 'base64'));
}

async function decodeToPcm(mp3Path, tempo) {
  const filters = ['silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB'];
  if (tempo > 1.005) filters.push(`atempo=${tempo.toFixed(3)}`);
  const { stdout } = await ff(['-i', mp3Path, '-af', filters.join(','), '-f', 's16le', '-ac', '1', '-ar', String(tl.SAMPLE_RATE), 'pipe:1'], { encoding: 'buffer', maxBuffer: 1024 * 1024 * 200 });
  const ab = stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.length - (stdout.length % 2));
  return new Int16Array(ab);
}

// Splits very long lines so every TTS request stays small.
function splitLongText(text, maxChars = 700) {
  if (text.length <= maxChars) return [text];
  const sentences = text.match(/[^.!?。！？۔]+[.!?。！？۔]*/g) || [text];
  const out = []; let cur = '';
  for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
    if ((cur + ' ' + s).trim().length > maxChars && cur) { out.push(cur); cur = s; } else cur = (cur ? cur + ' ' : '') + s;
  }
  if (cur) out.push(cur);
  return out.flatMap((c) => (c.length > maxChars ? c.match(new RegExp(`.{1,${maxChars}}`, 'g')) : [c]));
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---- Public: the dub track -------------------------------------------------
/**
 * @param {string} sourceFilePath video (or audio) to dub
 * @param {string} destAudioPath  where to write the dub track (WAV, as long as the video)
 * @param {object} o { targetLanguage, sourceLanguage, fallbackVoice }
 * @returns {Promise<{speakers:number, lines:number, overruns:number}>}
 */
async function dubVideoMultiVoice(sourceFilePath, destAudioPath, { targetLanguage, sourceLanguage = null, fallbackVoice = null, voiceShift = 0 } = {}) {
  const languageCode = TTS_LANGUAGE_CODES[targetLanguage];
  if (!languageCode) throw new Error(`"${targetLanguage}" isn't a supported dub language. Supported: ${Object.keys(TTS_LANGUAGE_CODES).join(', ')}`);
  const targetLabel = LANGUAGE_LABEL[targetLanguage] || (targetLanguage.charAt(0).toUpperCase() + targetLanguage.slice(1));

  const dir = path.dirname(destAudioPath);
  const base = path.basename(destAudioPath).replace(/\.[^.]+$/, '');
  const scratch = [];
  const mark = (p) => { scratch.push(p); return p; };

  try {
    const total = await mediaDuration(sourceFilePath);
    if (total > MAX_VIDEO_SECONDS) throw new Error('Multi-voice dub supports videos up to 60 minutes. Use a shorter video, or make clips first.');

    // 1. audio + parts. The working copy is an uncompressed WAV so cutting it
    //    is sample-accurate; parts are short (~2.5 min) because the AI's
    //    timestamps are more exact on short audio than on a long one.
    const fullAudio = mark(path.join(dir, `${base}_mv_full.wav`));
    await ff(['-i', sourceFilePath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', fullAudio]);
    const silences = await detectSilences(fullAudio);
    const chunks = tl.planChunks(total, { target: 150, window: 20, silences: silences.map((s) => (s.start + s.end) / 2) });
    logger.info(`[multivoice-dub] ${total.toFixed(0)}s of video -> ${chunks.length} part(s) for transcription, ${silences.length} silence(s) found`);

    // 2. who says what, when (parts one after another so speaker ids carry over)
    let all = [];
    let known = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const part = mark(path.join(dir, `${base}_mv_part${i}.mp3`));
      await ff(['-ss', String(c.start), '-i', fullAudio, '-t', String(c.end - c.start), '-c:a', 'libmp3lame', '-b:a', '48k', '-ar', '16000', '-ac', '1', part]);
      const raw = await geminiSegments(part, { targetLabel, sourceLanguage, known });
      const segs = tl.normalizeSegments(raw, { offset: c.start, chunkLength: c.end - c.start });
      all = all.concat(segs);
      known = tl.summarizeSpeakers(all).map((s) => ({ id: s.id, gender: s.gender, note: s.note }));
      logger.info(`[multivoice-dub] part ${i + 1}/${chunks.length}: ${segs.length} line(s), ${known.length} speaker(s) so far`);
    }
    if (!all.length) throw new Error('No speech was found in this video, so there is nothing to dub.');
    all.sort((a, b) => a.start - b.start);

    // Pin every line to where speech really starts/ends in the original audio.
    const snap = tl.snapToSpeech(all, silences);
    const shifts = snap.lines.map((l) => Math.abs(l.start - l.rawStart));
    logger.info(`[multivoice-dub] timing: ${snap.snapped}/${all.length} line starts matched to real speech, average correction ${(shifts.reduce((a, b) => a + b, 0) / Math.max(shifts.length, 1)).toFixed(2)}s, largest ${Math.max(0, ...shifts).toFixed(2)}s`);
    const lines = tl.mergeSegments(snap.lines);

    // 3. voices
    const speakers = tl.summarizeSpeakers(lines);
    const pools = await voicePools(languageCode);
    const voices = tl.assignVoices(speakers, pools);
    logger.info(`[multivoice-dub] ${speakers.length} speaker(s): ${speakers.map((s) => `${s.id}=${voices.get(s.id).voice}(${voices.get(s.id).gender}, ${s.lines} lines)`).join(', ')}`);

    // 4. speak every line, then place it on the timeline
    let failed = 0;
    const spoken = await mapLimit(lines, TTS_CONCURRENCY, async (line, i) => {
      const voice = (voices.get(line.speaker) || {}).voice || fallbackVoice || KNOWN_MALE[0];
      try {
        const pieces = [];
        const parts = splitLongText(line.text);
        for (let k = 0; k < parts.length; k++) {
          const mp3 = mark(path.join(dir, `${base}_mv_l${i}_${k}.mp3`));
          await synthesize(parts[k], mp3, voice, languageCode);
          pieces.push(mp3);
        }
        return pieces;
      } catch (err) {
        failed += 1;
        logger.warn(`[multivoice-dub] line ${i} (${line.speaker}) could not be spoken: ${err.message}`);
        return null;
      }
    });
    if (failed / lines.length > MAX_TTS_FAIL_RATIO) throw new Error(`Speech synthesis failed for ${failed} of ${lines.length} lines - please try again.`);

    // length of each spoken line, then tempo/placement
    const measured = [];
    for (let i = 0; i < lines.length; i++) {
      if (!spoken[i]) continue;
      let dur = 0;
      for (const p of spoken[i]) dur += await mediaDuration(p);
      measured.push({ i, start: lines[i].start, end: lines[i].end, dur });
    }
    const plan = tl.planPlacement(measured, total, { shift: Math.min(Math.max(Number(voiceShift) || 0, 0), 3) });
    const items = [];
    const spans = [];
    const cueLines = [];
    for (let k = 0; k < measured.length; k++) {
      const { i } = measured[k];
      const place = plan.items[k];
      const chunksPcm = [];
      for (const p of spoken[i]) chunksPcm.push(await decodeToPcm(p, place.tempo));
      const len = chunksPcm.reduce((a, b) => a + b.length, 0);
      const pcm = new Int16Array(len);
      let off = 0; for (const c of chunksPcm) { pcm.set(c, off); off += c.length; }
      items.push({ pcm, startSec: place.startSec });
      const lineSpan = { start: Math.min(lines[i].start, place.startSec), end: Math.max(lines[i].end, place.startSec + place.placedDuration) };
      spans.push({ start: lineSpan.start - 0.15, end: lineSpan.end + 0.15 });
      cueLines.push({ start: lines[i].start, end: lineSpan.end, speaker: lines[i].speaker });
      spoken[i].forEach((p) => { try { fs.unlinkSync(p); } catch (_) {} });
    }

    // 5. one dub track, exactly as long as the video
    const mixed = tl.mixPcm(items, total);
    fs.writeFileSync(destAudioPath, tl.encodeWav(mixed));
    logger.info(`[multivoice-dub] done: ${lines.length} lines, ${speakers.length} speakers, ${plan.overruns} line(s) slightly overlap the next one`);
    // Lines whose speech failed still count as dialogue (never cut there).
    lines.forEach((l, i) => { if (!spoken[i]) spans.push({ start: l.start - 0.15, end: l.end + 0.15 }); });
    // Where people talk (never cut) and where a sound-effect + zoom fits - used
    // by services.dubFinishService.js for the optional "cut silences" / "SFX zoom".
    const cues = tl.planSfxCues(cueLines, total);
    return { speakers: speakers.length, lines: lines.length, overruns: plan.overruns, spans, cues, total };
  } finally {
    scratch.forEach((p) => { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {} });
  }
}

// ---- Public: keep the original audio, quietly, under a dub -----------------
/**
 * Blends the video's original audio (at `volume`, 0-0.5) with the dub track.
 * Works for any dub (single voice or multi-voice). Videos without an audio
 * track just keep the dub. The result is as long as the longer of the two.
 */
async function mixOriginalUnder(videoPath, dubAudioPath, volume, outPath) {
  const v = tl.clampOriginalVolume(volume);
  if (v <= 0 || !(await hasAudioStream(videoPath))) {
    await ff(['-i', dubAudioPath, '-c:a', 'aac', '-b:a', '192k', outPath]);
    return outPath;
  }
  const filter = `[0:a]volume=${v.toFixed(3)}[o];[1:a]volume=1[d];[o][d]amix=inputs=2:duration=longest:dropout_transition=0,volume=2,alimiter=limit=0.95[a]`;
  await ff(['-i', videoPath, '-i', dubAudioPath, '-filter_complex', filter, '-map', '[a]', '-c:a', 'aac', '-b:a', '192k', outPath]);
  return outPath;
}

module.exports = { dubVideoMultiVoice, mixOriginalUnder, TTS_LANGUAGE_CODES };
