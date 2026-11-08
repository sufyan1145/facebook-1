/**
 * Hides on-screen text and logos (captions, lower-thirds, tickers, channel logos,
 * watermarks...) in images and short video clips.
 *
 * 1. Gemini (Vertex AI) looks at frames and returns where the text/logos are.
 * 2. ffmpeg hides exactly those regions, only while they are on screen:
 *      blur : strong gaussian blur (default - looks natural, text unreadable)
 *      fill : delogo - fills the area from its surroundings
 *      box  : solid black box
 * Detection is AI-based, so tiny or very fast-moving text can occasionally be missed.
 * Callers treat any failure here as "keep the original" (never kill the whole job).
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./utils.logger');
const vertexAiService = require('./services.vertexAiService');

const MAX_TRACKS = 24;
const BATCH = 8;

function exec(cmd, args, timeout = 300000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 20, timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${cmd} failed: ${String(stderr || err.message).slice(-400)}`));
      resolve(stdout);
    });
  });
}

async function probeSize(file) {
  const out = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file], 30000);
  const [w, h] = String(out).trim().split('x').map(Number);
  if (!w || !h) throw new Error('could not read the video size');
  return { W: w, H: h };
}

const area = (b) => b.w * b.h;
function intersect(a, b) {
  const x1 = Math.max(a.x, b.x); const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w); const y2 = Math.min(a.y + a.h, b.y + b.h);
  return x2 > x1 && y2 > y1 ? (x2 - x1) * (y2 - y1) : 0;
}
function union(a, b) {
  const x = Math.min(a.x, b.x); const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
// A little margin so the edges of letters / logo glow are covered too.
function pad(b) {
  const px = Math.max(0.015, b.w * 0.12); const py = Math.max(0.012, b.h * 0.25);
  const x = Math.max(0, b.x - px); const y = Math.max(0, b.y - py);
  return { x, y, w: Math.min(1, b.x + b.w + px) - x, h: Math.min(1, b.y + b.h + py) - y };
}

// Same region on consecutive frames = one "track" shown for that whole time range.
function buildTracks(perFrameBoxes, stepSec) {
  const tracks = [];
  perFrameBoxes.forEach((boxes, i) => {
    for (const raw of boxes) {
      const b = pad(raw);
      const t = tracks.find((tr) => tr.end === i && intersect(tr.box, b) / Math.min(area(tr.box), area(b)) > 0.3);
      if (t) { t.box = union(t.box, b); t.end = i + 1; } else tracks.push({ box: b, start: i, end: i + 1 });
    }
  });
  tracks.sort((a, b) => area(b.box) - area(a.box));
  return tracks.slice(0, MAX_TRACKS).map((t) => ({ box: t.box, from: Math.max(0, t.start * stepSec - 0.15), to: t.end * stepSec + 0.15 }));
}

function pixels(b, W, H) {
  let x = Math.round(b.x * W); let y = Math.round(b.y * H);
  let w = Math.round(b.w * W); let h = Math.round(b.h * H);
  x = Math.min(Math.max(1, x), W - 10); y = Math.min(Math.max(1, y), H - 10);
  w = Math.max(8, Math.min(w, W - 1 - x)); h = Math.max(8, Math.min(h, H - 1 - y));
  return { x, y, w: w - (w % 2), h: h - (h % 2) };
}

function buildGraph(tracks, W, H, mode) {
  const f = (n) => Number(n).toFixed(2);
  const parts = []; let cur = '0:v';
  tracks.forEach((t, k) => {
    const { x, y, w, h } = pixels(t.box, W, H);
    const en = `enable='between(t,${f(t.from)},${f(t.to)})'`;
    const out = `v${k + 1}`;
    if (mode === 'box') parts.push(`[${cur}]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=black@1:t=fill:${en}[${out}]`);
    else if (mode === 'fill') parts.push(`[${cur}]delogo=x=${x}:y=${y}:w=${w}:h=${h}:${en}[${out}]`);
    else {
      const sigma = Math.max(10, Math.round(Math.min(w, h) / 3));
      parts.push(`[${cur}]split[a${k}][b${k}]`);
      parts.push(`[b${k}]crop=${w}:${h}:${x}:${y},gblur=sigma=${sigma}:steps=2[bl${k}]`);
      parts.push(`[a${k}][bl${k}]overlay=${x}:${y}:${en}[${out}]`);
    }
    cur = out;
  });
  return { graph: parts.join(';'), last: cur };
}

async function detect(framePaths) {
  const all = [];
  for (let i = 0; i < framePaths.length; i += BATCH) {
    const res = await vertexAiService.detectTextAndLogoBoxes(framePaths.slice(i, i + BATCH));
    all.push(...res);
  }
  return all;
}

/** Hides text/logos in one still image. Returns true when the file was changed. */
async function cleanImage(imagePath, { mode = 'blur' } = {}) {
  const { W, H } = await probeSize(imagePath);
  const [boxes] = await detect([imagePath]);
  if (!boxes || !boxes.length) return false;
  const tracks = buildTracks([boxes], 1).map((t) => ({ ...t, from: 0, to: 9999 }));
  const { graph, last } = buildGraph(tracks, W, H, mode);
  const tmp = imagePath.replace(/(\.\w+)$/, '.clean$1');
  await exec('ffmpeg', ['-y', '-i', imagePath, '-filter_complex', graph, '-map', `[${last}]`, '-frames:v', '1', '-update', '1', tmp], 120000);
  fs.renameSync(tmp, imagePath);
  logger.info(`[overlay-clean] image: hid ${tracks.length} text/logo region(s)`);
  return true;
}

/** Hides text/logos in a short video clip (video stream only). Returns true when changed. */
async function cleanVideoClip(clipPath, { mode = 'blur' } = {}) {
  const { W, H } = await probeSize(clipPath);
  const dir = fs.mkdtempSync(path.join(path.dirname(clipPath), 'ovl_'));
  try {
    // One frame per second, taken in the middle of each second.
    await exec('ffmpeg', ['-y', '-ss', '0.5', '-i', clipPath, '-vf', 'fps=1,scale=640:-2', '-q:v', '3', path.join(dir, 'f_%03d.jpg')], 120000);
    let frames = fs.readdirSync(dir).filter((n) => n.endsWith('.jpg')).sort().map((n) => path.join(dir, n));
    if (!frames.length) {
      await exec('ffmpeg', ['-y', '-i', clipPath, '-vframes', '1', '-vf', 'scale=640:-2', '-q:v', '3', path.join(dir, 'f_001.jpg')], 60000);
      frames = [path.join(dir, 'f_001.jpg')];
    }
    const perFrame = await detect(frames);
    const tracks = buildTracks(perFrame, 1);
    if (!tracks.length) return false;
    const { graph, last } = buildGraph(tracks, W, H, mode);
    const tmp = clipPath.replace(/\.mp4$/, '.clean.mp4');
    await exec('ffmpeg', ['-y', '-i', clipPath, '-filter_complex', graph, '-map', `[${last}]`, '-r', '25', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-threads', '3', '-an', tmp], 600000);
    fs.renameSync(tmp, clipPath);
    logger.info(`[overlay-clean] clip: hid ${tracks.length} text/logo region(s)`);
    return true;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { cleanImage, cleanVideoClip };
