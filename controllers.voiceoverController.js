const fs = require('fs');
const logger = require('./utils.logger');
const Log = require('./models.Log');
const { VoiceoverJob, VoiceClone } = require('./models.Voiceover');
const svc = require('./services.voiceoverService');
const txt = require('./utils.voiceoverText');

class BadRequest extends Error {}
const bad = (m) => { throw new BadRequest(m); };
const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ success: false, message: err.message });
    if (err.code === 'CLONE_NOT_ALLOWED') return res.status(403).json({ success: false, code: err.code, message: err.message });
    logger.error(`[voiceover] ${req.method} ${req.path}: ${err.message}`);
    next(err);
  }
};

// Delete expired files (and their rows' paths) now and then.
let lastClean = 0;
async function housekeeping() {
  if (Date.now() - lastClean < 10 * 60 * 1000) return;
  lastClean = Date.now();
  try { await VoiceoverJob.expireOld(svc.FILE_TTL_DAYS); svc.cleanOldFiles(); } catch (_) { /* best effort */ }
}

const voices = wrap(async (req, res) => {
  const all = await svc.listVoices();
  // Compact form: the page groups / filters on its own.
  res.json({ success: true, data: all.map((v) => [v.name, v.languageCode, v.gender === 'male' ? 'M' : 'F', v.family, v.short]) });
});

const preview = wrap(async (req, res) => {
  const b = req.body || {};
  let voiceName = null; let cloneKey = null; let languageCode = String(b.languageCode || '');
  if (b.cloneId) {
    const clone = await VoiceClone.findWithKey(req.user.id, String(b.cloneId));
    if (!clone) bad('That cloned voice was not found.');
    cloneKey = clone.voice_key; languageCode = clone.language_code;
  } else {
    voiceName = String(b.voiceName || '');
    const v = (await svc.listVoices()).find((x) => x.name === voiceName && x.languageCode === languageCode);
    if (!v) bad('Choose a voice first.');
  }
  const mp3 = await svc.previewVoice({
    voiceName, languageCode, cloneKey, text: b.text, rate: txt.clampRate(b.speakingRate), pitch: txt.clampPitch(b.pitch),
  });
  res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=600' }).send(mp3);
});

const create = wrap(async (req, res) => {
  const b = req.body || {};
  const text = txt.normalizeText(b.text);
  if (text.length < 2) bad('Paste or type the text to speak.');
  const rate = txt.clampRate(b.speakingRate);
  const pitch = txt.clampPitch(b.pitch);
  const estMinutes = txt.estimateMinutes(text.length, rate);
  if (text.length > txt.maxCharsFor(rate)) {
    bad(`This text is about ${Math.round(estMinutes)} minutes of speech. The limit is ${txt.MAX_MINUTES} minutes (about ${txt.maxCharsFor(rate).toLocaleString('en-US')} characters at this speed). Split it into two voice-overs.`);
  }
  if (await VoiceoverJob.hasActive(req.user.id)) bad('A voice-over is already being made. Wait for it to finish first.');

  let languageCode; let voiceName = null; let cloneId = null; let cloneKey = null; let label; let mode = 'tts';
  if (b.cloneId) {
    mode = 'clone';
    const clone = await VoiceClone.findWithKey(req.user.id, String(b.cloneId));
    if (!clone) bad('That cloned voice was not found.');
    languageCode = clone.language_code; cloneId = clone.id; cloneKey = clone.voice_key; label = `Clone: ${clone.name}`;
  } else {
    languageCode = String(b.languageCode || '');
    voiceName = String(b.voiceName || '');
    const v = (await svc.listVoices()).find((x) => x.name === voiceName && x.languageCode === languageCode);
    if (!v) bad('Choose a voice first.');
    label = `${v.short} (${v.gender}, ${v.family})`;
  }
  const job = await VoiceoverJob.create(req.user.id, {
    mode, title: String(b.title || '').trim().slice(0, 120) || text.slice(0, 50), languageCode, voiceName, cloneId, voiceLabel: label,
    speakingRate: rate, pitchSemitones: pitch, charCount: text.length, estMinutes,
  });
  await Log.record(req.user.id, 'Voice Over Started', { jobId: job.id, chars: text.length, mode });
  svc.enqueue(job, { text, cloneKey });
  res.status(202).json({ success: true, data: job });
});

const list = wrap(async (req, res) => {
  await housekeeping();
  res.json({ success: true, data: await VoiceoverJob.listByUser(req.user.id) });
});

const remove = wrap(async (req, res) => {
  const row = await VoiceoverJob.remove(req.user.id, req.params.id);
  if (row && row.file_path) fs.unlink(row.file_path, () => {});
  res.json({ success: true });
});

// Audio with HTTP Range support (so the player can seek in a 100-minute file).
const file = wrap(async (req, res) => {
  const job = await VoiceoverJob.findById(req.user.id, req.params.id);
  if (!job) return res.status(404).json({ success: false, message: 'Not found' });
  if (job.status !== 'completed' || !job.file_path) return res.status(409).json({ success: false, message: 'This voice-over is not ready' });
  if (!fs.existsSync(job.file_path)) return res.status(410).json({ success: false, message: `This voice-over has expired (files are kept ${svc.FILE_TTL_DAYS} days).` });
  const { size } = fs.statSync(job.file_path);
  const safe = (job.title || 'voice-over').replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'voice-over';
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${safe}.mp3"`);
  res.setHeader('Accept-Ranges', 'bytes');
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (!range) { res.setHeader('Content-Length', size); return fs.createReadStream(job.file_path).pipe(res); }
  let start = range[1] ? parseInt(range[1], 10) : 0;
  let end = range[2] ? parseInt(range[2], 10) : size - 1;
  if (!range[1] && range[2]) { start = Math.max(size - parseInt(range[2], 10), 0); end = size - 1; }
  if (Number.isNaN(start) || start >= size || end < start) { res.status(416).setHeader('Content-Range', `bytes */${size}`); return res.end(); }
  end = Math.min(end, size - 1);
  res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', end - start + 1);
  return fs.createReadStream(job.file_path, { start, end }).pipe(res);
});

// ---- voice cloning --------------------------------------------------------------
const cloneLanguages = wrap(async (req, res) => {
  res.json({ success: true, data: Object.entries(svc.CLONE_LANGUAGES).map(([code, script]) => ({ code, script })) });
});

const listClones = wrap(async (req, res) => {
  res.json({ success: true, data: await VoiceClone.listByUser(req.user.id) });
});

const createClone = wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) bad('Give this voice a name.');
  const languageCode = String(b.languageCode || '');
  if (!svc.CLONE_LANGUAGES[languageCode]) bad('Voice cloning is not available for this language.');
  if (b.ownerConfirmed !== true) bad('Please confirm that you own this voice or have the speaker\'s permission.');
  if (!b.referenceAudio || !b.consentAudio) bad('Both recordings are required: the reference voice and the consent sentence.');
  let key;
  try {
    key = await svc.createCloneKey({ languageCode, referenceBase64: b.referenceAudio, consentBase64: b.consentAudio });
  } catch (err) {
    if (err.code === 'CLONE_NOT_ALLOWED') throw err;
    bad(err.message);
  }
  const row = await VoiceClone.create(req.user.id, { name, languageCode, key });
  await Log.record(req.user.id, 'Voice Clone Created', { cloneId: row.id, languageCode });
  res.status(201).json({ success: true, data: row });
});

const removeClone = wrap(async (req, res) => {
  await VoiceClone.remove(req.user.id, req.params.id);
  res.json({ success: true });
});

module.exports = { voices, preview, create, list, remove, file, cloneLanguages, listClones, createClone, removeClone };
