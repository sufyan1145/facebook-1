/**
 * Voice Over: text-to-speech with Google Cloud TTS (same Vertex/Google credentials the app
 * already uses) + voice cloning (Chirp 3 Instant Custom Voice, needs Google's approval).
 *
 *  - up to 100 minutes of narration in ONE job: the text is cut into sentence-safe
 *    chunks, spoken 3 at a time, and the audio is appended to ONE raw file in order
 *    (never all in memory), then encoded to MP3 once.
 *  - gender is Google's own `ssmlGender` - a "male" voice is always male. The optional
 *    pitch "character" is limited to +-3 semitones so it never flips the gender.
 *
 * Self-contained: own auth, no existing service is changed.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const { GoogleAuth } = require('google-auth-library');
const env = require('./config.env');
const logger = require('./utils.logger');
const txt = require('./utils.voiceoverText');
const { VoiceoverJob } = require('./models.Voiceover');

const TTS_V1 = 'https://texttospeech.googleapis.com/v1';
const TTS_V1BETA1 = 'https://texttospeech.googleapis.com/v1beta1';
const SAMPLE_RATE = 24000;
const CONCURRENCY = 3;
const OUT_DIR = () => path.join(env.upload.tempDir, 'voiceover');
const FILE_TTL_DAYS = 7;

// Cloning: languages + the EXACT consent sentence Google requires (custom ones are rejected).
const CLONE_LANGUAGES = {
  'en-US': 'I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.',
  'en-GB': 'I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.',
  'en-AU': 'I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.',
  'en-IN': 'I am the owner of this voice and I consent to Google using this voice to create a synthetic voice model.',
  'hi-IN': 'मैं इस आवाज का मालिक हूं और मैं सिंथेटिक आवाज मॉडल बनाने के लिए Google को इस आवाज का उपयोग करने की सहमति देता हूं',
  'ar-XA': '.أنا مالك هذا الصوت وأوافق على أن تستخدم Google هذا الصوت لإنشاء نموذج صوتي اصطناعي',
  'bn-IN': 'আমি এই ভয়েসের মালিক এবং আমি একটি সিন্থেটিক ভয়েস মডেল তৈরি করতে এই ভয়েস ব্যবহার করে Google-এর সাথে সম্মতি দিচ্ছি।',
  'cmn-CN': '我是此声音的拥有者并授权谷歌使用此声音创建语音合成模型',
  'fr-FR': "Je suis le propriétaire de cette voix et j'autorise Google à utiliser cette voix pour créer un modèle de voix synthétique.",
  'fr-CA': "Je suis le propriétaire de cette voix et j'autorise Google à utiliser cette voix pour créer un modèle de voix synthétique.",
  'de-DE': 'Ich bin der Eigentümer dieser Stimme und bin damit einverstanden, dass Google diese Stimme zur Erstellung eines synthetischen Stimmmodells verwendet.',
  'gu-IN': 'હું આ વોઈસનો માલિક છું અને સિન્થેટિક વોઈસ મોડલ બનાવવા માટે આ વોઈસનો ઉપયોગ કરીને google ને હું સંમતિ આપું છું',
  'id-ID': 'Saya pemilik suara ini dan saya menyetujui Google menggunakan suara ini untuk membuat model suara sintetis.',
  'it-IT': 'Sono il proprietario di questa voce e acconsento che Google la utilizzi per creare un modello di voce sintetica.',
  'ja-JP': '私はこの音声の所有者であり、Googleがこの音声を使用して音声合成 モデルを作成することを承認します。',
  'kn-IN': 'ನಾನು ಈ ಧ್ವನಿಯ ಮಾಲಿಕ ಮತ್ತು ಸಂಶ್ಲೇಷಿತ ಧ್ವನಿ ಮಾದರಿಯನ್ನು ರಚಿಸಲು ಈ ಧ್ವನಿಯನ್ನು ಬಳಸಿಕೊಂಡುಗೂಗಲ್ ಗೆ ನಾನು ಸಮ್ಮತಿಸುತ್ತೇನೆ.',
  'ko-KR': '나는 이 음성의 소유자이며 구글이 이 음성을 사용하여 음성 합성 모델을 생성할 것을 허용합니다.',
  'mr-IN': 'मी या आवाजाचा मालक आहे आणि सिंथेटिक व्हॉइस मॉडेल तयार करण्यासाठी हा आवाज वापरण्यासाठी मी Google ला संमती देतो',
  'nl-NL': 'Ik ben de eigenaar van deze stem en ik geef Google toestemming om deze stem te gebruiken om een synthetisch stemmodel te maken.',
  'pl-PL': 'Jestem właścicielem tego głosu i wyrażam zgodę na wykorzystanie go przez Google w celu utworzenia syntetycznego modelu głosu.',
  'pt-BR': 'Eu sou o proprietário desta voz e autorizo o Google a usá-la para criar um modelo de voz sintética.',
  'ru-RU': 'Я являюсь владельцем этого голоса и даю согласие Google на использование этого голоса для создания модели синтетического голоса.',
  'ta-IN': 'நான் இந்த குரலின் உரிமையாளர் மற்றும் செயற்கை குரல் மாதிரியை உருவாக்க இந்த குரலை பயன்படுத்த குகல்க்கு நான் ஒப்புக்கொள்கிறேன்.',
  'te-IN': 'నేను ఈ వాయిస్ యజమానిని మరియు సింతటిక్ వాయిస్ మోడల్ ని రూపొందించడానికి ఈ వాయిస్ ని ఉపయోగించడానికి googleకి నేను సమ్మతిస్తున్నాను.',
  'th-TH': 'ฉันเป็นเจ้าของเสียงนี้ และฉันยินยอมให้ Google ใช้เสียงนี้เพื่อสร้างแบบจำลองเสียงสังเคราะห์',
  'tr-TR': "Bu sesin sahibi benim ve Google'ın bu sesi kullanarak sentetik bir ses modeli oluşturmasına izin veriyorum.",
  'vi-VN': 'Tôi là chủ sở hữu giọng nói này và tôi đồng ý cho Google sử dụng giọng nói này để tạo mô hình giọng nói tổng hợp.',
  'es-ES': 'Soy el propietario de esta voz y doy mi consentimiento para que Google la utilice para crear un modelo de voz sintética.',
  'es-US': 'Soy el propietario de esta voz y doy mi consentimiento para que Google la utilice para crear un modelo de voz sintética.',
};

// ---- auth -------------------------------------------------------------------
let authClient = null;
async function accessToken() {
  if (!authClient) {
    if (!env.vertexAi.credentialsBase64) throw new Error('VERTEX_CREDENTIALS_BASE64 is not set');
    const credentials = JSON.parse(Buffer.from(env.vertexAi.credentialsBase64, 'base64').toString('utf8'));
    authClient = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  }
  const t = await (await authClient.getClient()).getAccessToken();
  return typeof t === 'string' ? t : t.token;
}
async function headers(extra = {}) {
  const h = { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...extra };
  if (env.vertexAi.projectId) h['x-goog-user-project'] = env.vertexAi.projectId;
  return h;
}

function googleError(err) {
  const status = err.response && err.response.status;
  const msg = err.response && err.response.data && err.response.data.error && err.response.data.error.message;
  if (status === 403 && /voice.?clon|allow|permission|not.*enabled|restricted/i.test(msg || '')) {
    const e = new Error('Google has not enabled voice cloning for your project yet (Instant Custom Voice is allowlist-only). Ask Google Cloud sales for access, then try again.');
    e.code = 'CLONE_NOT_ALLOWED';
    return e;
  }
  if (status === 403) return new Error(`Google refused the request (403): ${msg || 'check that the Cloud Text-to-Speech API is enabled for your project'}`);
  return new Error(msg || err.message);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, label) {
  const waits = [2000, 5000, 15000, 30000];
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (err) {
      const s = err.response && err.response.status;
      const transient = s === 429 || (s >= 500 && s < 600) || ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND'].includes(err.code);
      if (!transient || i >= waits.length) throw err;
      logger.info(`[voiceover] ${label}: ${s || err.code}, retry ${i + 1}/${waits.length} in ${waits[i] / 1000}s`);
      await sleep(waits[i]);
    }
  }
}

// ---- voices -----------------------------------------------------------------
let voiceCache = { at: 0, voices: null };
async function listVoices({ force = false } = {}) {
  if (!force && voiceCache.voices && Date.now() - voiceCache.at < 6 * 3600 * 1000) return voiceCache.voices;
  const { data } = await withRetry(async () => axios.get(`${TTS_V1}/voices`, { headers: await headers(), timeout: 30000 }), 'voices.list');
  const voices = txt.normalizeVoices(data.voices || []);
  if (!voices.length) throw new Error('Google returned no voices');
  voiceCache = { at: Date.now(), voices };
  return voices;
}

// ---- one chunk -> WAV bytes -------------------------------------------------------
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let pos = 12; let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(pos + 10), sampleRate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    if (id === 'data') return { ...fmt, pcm: buf.subarray(pos + 8, Math.min(pos + 8 + size, buf.length)) };
    pos += 8 + size + (size % 2);
  }
  return null;
}

async function synthesize(text, { voiceName, languageCode, cloneKey, rate = 1 }) {
  const voice = cloneKey
    ? { language_code: languageCode, voice_clone: { voice_cloning_key: cloneKey } }
    : { languageCode, name: voiceName };
  const url = `${cloneKey ? TTS_V1BETA1 : TTS_V1}/text:synthesize`;
  const body = { input: { text }, voice, audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: SAMPLE_RATE, speakingRate: rate } };
  if (rate === 1) delete body.audioConfig.speakingRate;
  try {
    const { data } = await withRetry(async () => axios.post(url, body, { headers: await headers(), timeout: 90000, maxBodyLength: Infinity }), 'synthesize');
    if (!data || !data.audioContent) throw new Error('Google returned no audio');
    return Buffer.from(data.audioContent, 'base64');
  } catch (err) {
    // a few voice types reject a speaking rate: say it once more without it
    if (err.response && err.response.status === 400 && body.audioConfig.speakingRate && /speaking|rate/i.test(JSON.stringify(err.response.data))) {
      delete body.audioConfig.speakingRate;
      const { data } = await withRetry(async () => axios.post(url, body, { headers: await headers(), timeout: 90000 }), 'synthesize');
      return Buffer.from(data.audioContent, 'base64');
    }
    throw googleError(err);
  }
}

// -> 24 kHz mono 16-bit PCM Buffer, whatever Google (or a clone) returned
async function toPcm(wavBuf) {
  const w = parseWav(wavBuf);
  if (w && w.channels === 1 && w.sampleRate === SAMPLE_RATE && w.bits === 16) return w.pcm;
  const dir = OUT_DIR(); fs.mkdirSync(dir, { recursive: true });
  const a = path.join(dir, `conv_${crypto.randomBytes(6).toString('hex')}.in`);
  const b = `${a}.wav`;
  try {
    fs.writeFileSync(a, wavBuf);
    await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-i', a, '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', b]);
    return parseWav(fs.readFileSync(b)).pcm;
  } finally { [a, b].forEach((f) => { try { fs.unlinkSync(f); } catch (_) { /* ignore */ } }); }
}

// ---- preview ------------------------------------------------------------------
const SAMPLE_TEXT = {
  en: 'Hello! This is a short sample of how this voice sounds.',
  ur: 'ہیلو! یہ اس آواز کا ایک مختصر نمونہ ہے۔',
  hi: 'नमस्ते! यह इस आवाज़ का एक छोटा सा नमूना है।',
  ar: 'مرحبًا! هذه عينة قصيرة من صوتي.',
  es: '¡Hola! Esta es una breve muestra de cómo suena esta voz.',
  fr: 'Bonjour ! Voici un court échantillon de cette voix.',
  de: 'Hallo! Das ist eine kurze Hörprobe dieser Stimme.',
  pt: 'Olá! Esta é uma breve amostra desta voz.',
  tr: 'Merhaba! Bu sesin kısa bir örneğidir.',
  id: 'Halo! Ini adalah contoh singkat suara ini.',
  bn: 'হ্যালো! এটি এই কণ্ঠের একটি ছোট নমুনা।',
  ru: 'Здравствуйте! Это короткий образец этого голоса.',
  it: 'Ciao! Questo è un breve campione di questa voce.',
  nl: 'Hallo! Dit is een kort voorbeeld van deze stem.',
  ja: 'こんにちは。これはこの声の短いサンプルです。',
  ko: '안녕하세요! 이 목소리의 짧은 샘플입니다.',
  cmn: '你好！这是这个声音的简短示例。',
  zh: '你好！这是这个声音的简短示例。',
};
const previewCache = new Map();
async function previewVoice({ voiceName, languageCode, cloneKey, text, rate = 1, pitch = 0 }) {
  const base = String(languageCode || 'en').split('-')[0].toLowerCase();
  const sample = (String(text || '').trim().slice(0, 160)) || SAMPLE_TEXT[base] || SAMPLE_TEXT.en;
  const key = crypto.createHash('sha1').update([voiceName, languageCode, cloneKey ? 'c' + cloneKey.slice(-12) : '', sample, rate, pitch].join('|')).digest('hex');
  if (previewCache.has(key)) return previewCache.get(key);
  const pcm = await toPcm(await synthesize(sample, { voiceName, languageCode, cloneKey, rate }));
  const mp3 = await encodePcmToMp3Buffer(pcm, { pitch, bitrate: '64k' });
  previewCache.set(key, mp3);
  if (previewCache.size > 150) previewCache.delete(previewCache.keys().next().value);
  return mp3;
}

function pitchFilter(semitones) {
  const st = txt.clampPitch(semitones);
  if (!st) return null;
  const f = Math.pow(2, st / 12);
  return `asetrate=${Math.round(SAMPLE_RATE * f)},aresample=${SAMPLE_RATE},atempo=${(1 / f).toFixed(5)}`;
}

async function encodePcmToMp3Buffer(pcm, { pitch = 0, bitrate = '64k' } = {}) {
  const dir = OUT_DIR(); fs.mkdirSync(dir, { recursive: true });
  const raw = path.join(dir, `pv_${crypto.randomBytes(6).toString('hex')}.raw`);
  const mp3 = `${raw}.mp3`;
  try {
    fs.writeFileSync(raw, pcm);
    await encodeRaw(raw, mp3, { pitch, bitrate });
    return fs.readFileSync(mp3);
  } finally { [raw, mp3].forEach((f) => { try { fs.unlinkSync(f); } catch (_) { /* ignore */ } }); }
}

function encodeRaw(rawPath, outPath, { pitch = 0, bitrate = '96k' } = {}) {
  const args = ['-y', '-loglevel', 'error', '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', rawPath];
  const pf = pitchFilter(pitch);
  if (pf) args.push('-af', pf);
  args.push('-c:a', 'libmp3lame', '-b:a', bitrate, '-ar', String(SAMPLE_RATE), outPath);
  return execFileAsync('ffmpeg', args, { maxBuffer: 1 << 26 });
}

// ---- the job (up to 100 minutes) -----------------------------------------------------
/**
 * job: row from voiceover_jobs; opts: { text, cloneKey }  (text is NOT stored in the DB)
 */
async function runVoiceoverJob(job, { text, cloneKey = null }) {
  const dir = OUT_DIR(); fs.mkdirSync(dir, { recursive: true });
  const rawPath = path.join(dir, `${job.id}.raw`);
  const outPath = path.join(dir, `${job.id}.mp3`);
  try {
    const chunks = txt.splitIntoChunks(text);
    if (!chunks.length) throw new Error('There is no text to speak');
    await VoiceoverJob.markProcessing(job.id, chunks.length);
    const rate = txt.clampRate(job.speaking_rate);
    const fd = fs.openSync(rawPath, 'w');
    const results = new Map();   // index -> pcm (only until written)
    let nextToWrite = 0; let nextToStart = 0; let done = 0; let failure = null; let lastSaved = 0;
    const silence = (sec) => Buffer.alloc(Math.round(sec * SAMPLE_RATE) * 2);
    const flush = () => {
      while (results.has(nextToWrite)) {
        fs.writeSync(fd, results.get(nextToWrite));
        const gap = chunks[nextToWrite].pauseAfter;
        if (gap > 0) fs.writeSync(fd, silence(gap));
        results.delete(nextToWrite);
        nextToWrite += 1;
      }
    };
    const worker = async () => {
      while (!failure) {
        const i = nextToStart++;
        if (i >= chunks.length) return;
        // do not run far ahead of the writer (keeps memory small)
        while (!failure && i - nextToWrite > CONCURRENCY * 4) await sleep(50);
        try {
          const wav = await synthesize(chunks[i].text, { voiceName: job.voice_name, languageCode: job.language_code, cloneKey, rate });
          results.set(i, await toPcm(wav));
          flush();
          done += 1;
          if (done - lastSaved >= 3 || done === chunks.length) { lastSaved = done; await VoiceoverJob.setProgress(job.id, done); }
        } catch (err) {
          failure = failure || new Error(`Part ${i + 1} of ${chunks.length} failed: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
    fs.closeSync(fd);
    if (failure) throw failure;
    flush();

    await encodeRaw(rawPath, outPath, { pitch: Number(job.pitch_semitones) || 0, bitrate: '96k' });
    const bytes = fs.statSync(outPath).size;
    const seconds = fs.statSync(rawPath).size / 2 / SAMPLE_RATE;
    await VoiceoverJob.complete(job.id, { filePath: outPath, seconds, bytes });
    logger.info(`[voiceover] job ${job.id} done: ${(seconds / 60).toFixed(1)} min, ${(bytes / 1048576).toFixed(1)} MB, ${chunks.length} parts`);
  } catch (err) {
    logger.error(`[voiceover] job ${job.id} failed: ${err.message}`);
    await VoiceoverJob.fail(job.id, String(err.message).slice(0, 500));
    try { fs.unlinkSync(outPath); } catch (_) { /* ignore */ }
  } finally {
    try { fs.unlinkSync(rawPath); } catch (_) { /* ignore */ }
  }
}

// One job at a time per server (CPU/network friendly); the controller allows one per user.
const queue = [];
let draining = false;
function enqueue(job, payload) {
  queue.push({ job, payload });
  drain();
}
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const { job, payload } = queue.shift();
      await runVoiceoverJob(job, payload);
    }
  } finally { draining = false; }
}

// ---- cloning ----------------------------------------------------------------------------
// Browser recordings (webm/ogg/m4a/wav/mp3) -> 24 kHz mono WAV, at most `maxSeconds`.
async function normalizeUploadedAudio(base64, maxSeconds) {
  const dir = OUT_DIR(); fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomBytes(6).toString('hex');
  const src = path.join(dir, `up_${id}.bin`); const dst = path.join(dir, `up_${id}.wav`);
  try {
    const buf = Buffer.from(String(base64 || '').replace(/^data:[^,]+,/, ''), 'base64');
    if (buf.length < 2000) throw new Error('The audio file is empty or too small');
    if (buf.length > 8 * 1024 * 1024) throw new Error('The audio file is too large (max 8 MB)');
    fs.writeFileSync(src, buf);
    const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', src]).catch(() => { throw new Error('This audio file could not be read. Use a recording (wav, mp3, m4a, webm).'); });
    const seconds = parseFloat(stdout);
    if (!(seconds > 1)) throw new Error('The recording is too short');
    if (seconds > maxSeconds + 1.5) throw new Error(`The recording is ${seconds.toFixed(0)} seconds; the maximum is ${maxSeconds} seconds`);
    await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-t', String(maxSeconds), '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', dst]);
    return { content: fs.readFileSync(dst).toString('base64'), seconds: Math.min(seconds, maxSeconds) };
  } finally { [src, dst].forEach((f) => { try { fs.unlinkSync(f); } catch (_) { /* ignore */ } }); }
}

async function createCloneKey({ languageCode, referenceBase64, consentBase64 }) {
  const script = CLONE_LANGUAGES[languageCode];
  if (!script) throw new Error('Voice cloning is not available for this language');
  const ref = await normalizeUploadedAudio(referenceBase64, 10);
  if (ref.seconds < 5) throw new Error('The reference recording is too short. Record about 10 seconds of natural, clear speech.');
  const consent = await normalizeUploadedAudio(consentBase64, 10);
  try {
    const { data } = await withRetry(async () => axios.post(`${TTS_V1BETA1}/voices:generateVoiceCloningKey`, {
      reference_audio: { audio_config: { audio_encoding: 'LINEAR16' }, content: ref.content },
      voice_talent_consent: { audio_config: { audio_encoding: 'LINEAR16' }, content: consent.content },
      consent_script: script,
      language_code: languageCode,
    }, { headers: await headers(), timeout: 120000, maxBodyLength: Infinity }), 'generateVoiceCloningKey');
    const key = data && (data.voiceCloningKey || data.voice_cloning_key);
    if (!key) throw new Error('Google did not return a voice key');
    return key;
  } catch (err) {
    if (err.code === 'CLONE_NOT_ALLOWED') throw err;
    const g = googleError(err);
    if (g.code) throw g;
    if (err.response && err.response.status === 400) throw new Error(`Google rejected the recordings: ${g.message}. Read the consent sentence exactly as shown, in a quiet room, and record the reference in the same place.`);
    throw g;
  }
}

function cleanOldFiles() {
  try {
    const dir = OUT_DIR(); const now = Date.now();
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      const old = now - fs.statSync(p).mtimeMs > FILE_TTL_DAYS * 86400000;
      const leftover = /^(up_|pv_|conv_)/.test(f) && now - fs.statSync(p).mtimeMs > 3600000;
      if (old || leftover) fs.unlinkSync(p);
    }
  } catch (_) { /* dir may not exist yet */ }
}

module.exports = {
  listVoices, synthesize, previewVoice, runVoiceoverJob, enqueue, createCloneKey, cleanOldFiles,
  parseWav, pitchFilter, CLONE_LANGUAGES, OUT_DIR, FILE_TTL_DAYS, SAMPLE_RATE,
};
