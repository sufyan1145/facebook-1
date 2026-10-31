// Optional finishing pass for a dubbed video (one ffmpeg run):
//  - cut long silent stretches (where nobody is talking)
//  - sound effect + quick zoom-in at chosen moments
// Times in `cuts` / `cues` are relative to the video as it is passed in.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const logger = require('./utils.logger');
const ffmpeg = require('./utils.ffmpeg');
const tl = require('./utils.dubTimeline');

const ZOOM_SECONDS = 0.5;
const ZOOM_AMOUNT = 0.25; // 25% closer at the peak

async function probeSize(file) {
  const { stdout } = await execFileAsync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]);
  const [w, h] = stdout.trim().split('x').map(Number);
  if (!w || !h) throw new Error('Could not read the video size');
  return { w, h };
}

function zoomExpr(times) {
  const terms = times.map((t) => `between(t,${t},${(t + ZOOM_SECONDS).toFixed(3)})*sin(PI*(t-${t})/${ZOOM_SECONDS})`);
  return `1+${ZOOM_AMOUNT}*(${terms.join('+')})`;
}

// Builds the filter graph (exported for tests). `keep` = kept segments or null.
function buildFilter({ keep, zoomTimes, sfx, w, h }) {
  const parts = [];
  let v = '[0:v]'; let a = '[0:a]';
  if (keep && keep.length) {
    keep.forEach((k, i) => {
      parts.push(`[0:v]trim=${k.start}:${k.end},setpts=PTS-STARTPTS[cv${i}]`);
      parts.push(`[0:a]atrim=${k.start}:${k.end},asetpts=PTS-STARTPTS[ca${i}]`);
    });
    parts.push(`${keep.map((_, i) => `[cv${i}][ca${i}]`).join('')}concat=n=${keep.length}:v=1:a=1[cv][ca]`);
    v = '[cv]'; a = '[ca]';
  }
  let vOut = v; let aOut = a === '[0:a]' ? '0:a' : a;
  if (zoomTimes.length) {
    const z = zoomExpr(zoomTimes);
    parts.push(`${v}scale=w='trunc(${w}*(${z})/2)*2':h='trunc(${h}*(${z})/2)*2':eval=frame,crop=${w}:${h},setsar=1,format=yuv420p[zv]`);
    vOut = '[zv]';
  }
  if (sfx && zoomTimes.length) {
    const n = zoomTimes.length;
    const labels = zoomTimes.map((_, i) => `[s${i}]`).join('');
    parts.push(n === 1 ? '[1:a]anull[s0]' : `[1:a]asplit=${n}${labels}`);
    zoomTimes.forEach((t, i) => parts.push(`[s${i}]adelay=${Math.round(Math.max(t - 0.05, 0) * 1000)}:all=1,volume=0.7[d${i}]`));
    parts.push(`${a}${zoomTimes.map((_, i) => `[d${i}]`).join('')}amix=inputs=${n + 1}:duration=first:dropout_transition=0,volume=${n + 1},alimiter=limit=0.95[ao]`);
    aOut = '[ao]';
  }
  return { filter: parts.join(';'), vOut, aOut };
}

/**
 * @param {string} input   dubbed video
 * @param {string} output  result mp4
 * @param {{cuts?:Array, cues?:number[], sfx?:boolean, total:number}} o
 * @returns {Promise<{removedSeconds:number, cues:number, output:string}>}
 */
async function finishDub(input, output, { cuts = [], cues = [], sfx = false, total, runFfmpeg } = {}) {
  const keep = cuts.length ? tl.keepSegments(cuts, total) : null;
  const removed = cuts.reduce((s, c) => s + (c.end - c.start), 0);
  const zoomTimes = cues.map((t) => (keep ? tl.mapTime(keep, t) : t));
  if (!keep && !zoomTimes.length) return { removedSeconds: 0, cues: 0, output: input };
  const { w, h } = zoomTimes.length ? await probeSize(input) : { w: 0, h: 0 };
  const { filter, vOut, aOut } = buildFilter({ keep, zoomTimes, sfx, w, h });
  const args = ['-i', input];
  let whoosh = null;
  if (sfx && zoomTimes.length) {
    whoosh = path.join(path.dirname(output), `${path.basename(output, '.mp4')}_whoosh.mp3`);
    await ffmpeg.generateWhooshSfx(whoosh);
    args.push('-i', whoosh);
  }
  const needsFilter = !!filter;
  if (needsFilter) args.push('-filter_complex', filter, '-map', vOut, '-map', aOut);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-threads', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', output);
  try {
    await (runFfmpeg ? runFfmpeg(args) : execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { maxBuffer: 1 << 26 }));
  } finally {
    if (whoosh) { try { fs.unlinkSync(whoosh); } catch (_) {} }
  }
  logger.info(`[dub-finish] removed ${removed.toFixed(1)}s of silence, ${zoomTimes.length} zoom/sfx moment(s)`);
  return { removedSeconds: removed, cues: zoomTimes.length, output };
}

module.exports = { finishDub, buildFilter, zoomExpr };
