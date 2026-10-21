// Pure helpers for the Video Editor's "Make clips from a long video" mode
// (no database, no ffmpeg - easy to test).

const MIN_CLIP_SECONDS = 5;
const MAX_CLIP_SECONDS = 3600;
const MIN_TAIL_SECONDS = 5;    // a left-over piece shorter than this is not worth a clip
const MAX_CLIPS_DRIVE = 100;   // per run, when clips are saved to Drive
const MAX_CLIPS_LOCAL = 20;    // per run, when clips stay on the server's disk

// Same video -> same key, even if the link differs a little (www/m, tracking
// params, youtu.be vs youtube.com/watch ...). Used to remember how far we got.
function normalizeSourceKey(raw) {
  const text = String(raw || '').trim();
  let u;
  try { u = new URL(text); } catch (_) { return text.toLowerCase(); }
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, '');
  if (host === 'youtu.be') {
    const id = u.pathname.split('/').filter(Boolean)[0];
    if (id) return `youtube.com/watch?v=${id}`;
  }
  if (host.endsWith('youtube.com')) {
    const v = u.searchParams.get('v');
    if (v) return `youtube.com/watch?v=${v}`;
    const m = u.pathname.match(/^\/(shorts|live|embed)\/([^/?#]+)/);
    if (m) return `youtube.com/watch?v=${m[2]}`;
  }
  const path = u.pathname.replace(/\/+$/, '');
  const keep = ['v', 'id', 'story_fbid', 'fbid', 'video_id'];
  const q = keep.filter((k) => u.searchParams.has(k)).map((k) => `${k}=${u.searchParams.get(k)}`).join('&');
  return `${host}${path}${q ? `?${q}` : ''}`;
}

function round3(n) { return Math.round(n * 1000) / 1000; }

function isFinished(nextStart, total) {
  return Number(total) - Number(nextStart) < MIN_TAIL_SECONDS;
}

// Plans the next batch of clips, continuing from `start`.
// Returns { clips: [{start, length}], endPos, finished }.
function planClips({ start, total, clipSeconds, maxClips, hardCap = MAX_CLIPS_DRIVE }) {
  const clips = [];
  let pos = Math.max(0, Number(start) || 0);
  const limit = Math.min(maxClips > 0 ? maxClips : hardCap, hardCap);
  const len0 = Number(clipSeconds);
  while (clips.length < limit) {
    const remaining = total - pos;
    if (remaining < MIN_TAIL_SECONDS) break;
    const len = Math.min(len0, remaining);
    clips.push({ start: round3(pos), length: round3(len) });
    pos += len;
  }
  return { clips, endPos: round3(pos), finished: isFinished(pos, total) };
}

function fmtTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(r).padStart(2, '0')}`;
}

// Validates what the page sent. Returns { ok, error, clipSeconds, maxClips }.
function validateClipSpec(raw, { saveToDrive }) {
  const clipSeconds = Math.round(Number(raw && raw.clipSeconds));
  if (!Number.isFinite(clipSeconds) || clipSeconds < MIN_CLIP_SECONDS || clipSeconds > MAX_CLIP_SECONDS) {
    return { ok: false, error: `Clip length must be between ${MIN_CLIP_SECONDS} seconds and ${MAX_CLIP_SECONDS / 60} minutes` };
  }
  let maxClips = null;
  if (raw && raw.maxClips !== null && raw.maxClips !== undefined && raw.maxClips !== '') {
    maxClips = Math.floor(Number(raw.maxClips));
    if (!Number.isFinite(maxClips) || maxClips < 1) {
      return { ok: false, error: 'Number of clips must be 1 or more (or leave it empty for all remaining)' };
    }
    const cap = saveToDrive ? MAX_CLIPS_DRIVE : MAX_CLIPS_LOCAL;
    if (maxClips > cap) {
      return { ok: false, error: `At most ${cap} clips per run${saveToDrive ? '' : ' when not saving to Drive (turn on "Save to Google Drive" for up to ' + MAX_CLIPS_DRIVE + ')'}` };
    }
  }
  return { ok: true, clipSeconds, maxClips };
}

module.exports = {
  MIN_CLIP_SECONDS, MAX_CLIP_SECONDS, MIN_TAIL_SECONDS, MAX_CLIPS_DRIVE, MAX_CLIPS_LOCAL,
  normalizeSourceKey, planClips, isFinished, fmtTime, validateClipSpec,
};
