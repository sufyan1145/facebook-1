/**
 * Non-AI "auto-highlight" extraction: shortens a long video down to a target
 * length by keeping the loudest/most "active" segments and cutting the
 * quieter stretches. No transcription or AI model involved - purely audio
 * energy based (ffmpeg's silencedetect), so it's free to run.
 *
 * IMPORTANT (communicated to the user elsewhere too): this reduces automated
 * fingerprint-matching risk by only keeping fragments and re-encoding them -
 * it does NOT make reposting someone else's copyrighted content legal.
 */
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const logger = require('./utils.logger');

const MIN_SEGMENT_SECONDS = 1.5;

// Runs ffmpeg's silencedetect over the given audio/video file and returns
// the "loud" (non-silent) segments as [{start, end}], sorted chronologically.
async function detectLoudSegments(mediaPath, totalDuration, { noiseDb = -30, minSilenceDuration = 0.6 } = {}) {
  let stderr = '';
  try {
    const result = await execFileAsync('ffmpeg', [
      '-i', mediaPath,
      '-af', `silencedetect=noise=${noiseDb}dB:d=${minSilenceDuration}`,
      '-f', 'null', '-',
    ], { timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024 * 20 });
    stderr = result.stderr || '';
  } catch (err) {
    // ffmpeg with -f null exits non-zero in some builds even on success;
    // the useful output is in stderr either way.
    stderr = err.stderr || '';
  }

  const silences = [];
  let pendingStart = null;
  const startRe = /silence_start:\s*([\d.]+)/;
  const endRe = /silence_end:\s*([\d.]+)/;
  stderr.split('\n').forEach((line) => {
    const startMatch = line.match(startRe);
    if (startMatch) pendingStart = parseFloat(startMatch[1]);
    const endMatch = line.match(endRe);
    if (endMatch && pendingStart != null) {
      silences.push({ start: pendingStart, end: parseFloat(endMatch[1]) });
      pendingStart = null;
    }
  });

  // Loud segments = the gaps between silences (plus start/end of file).
  const loud = [];
  let cursor = 0;
  silences.forEach((s) => {
    if (s.start > cursor) loud.push({ start: cursor, end: s.start });
    cursor = s.end;
  });
  if (cursor < totalDuration) loud.push({ start: cursor, end: totalDuration });

  return loud.filter((seg) => seg.end - seg.start >= MIN_SEGMENT_SECONDS);
}

// Picks the loudest segments (by duration, as a proxy for "sustained
// activity") until the target duration is reached, then re-sorts
// chronologically so the result still plays in original order.
function selectSegments(loudSegments, targetDurationSeconds) {
  const byDuration = [...loudSegments].sort((a, b) => (b.end - b.start) - (a.end - a.start));
  const selected = [];
  let total = 0;
  for (const seg of byDuration) {
    if (total >= targetDurationSeconds) break;
    selected.push(seg);
    total += seg.end - seg.start;
  }
  selected.sort((a, b) => a.start - b.start);
  return selected;
}

// Builds the ffmpeg filter_complex string (trim+concat) for the given segments.
function buildTrimConcatFilter(segments) {
  const parts = [];
  segments.forEach((seg, i) => {
    parts.push(`[0:v]trim=${seg.start}:${seg.end},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(`[0:a]atrim=${seg.start}:${seg.end},asetpts=PTS-STARTPTS[a${i}]`);
  });
  const concatInputs = segments.map((_, i) => `[v${i}][a${i}]`).join('');
  parts.push(`${concatInputs}concat=n=${segments.length}:v=1:a=1[outv][outa]`);
  return parts.join(';');
}

module.exports = { detectLoudSegments, selectSegments, buildTrimConcatFilter, MIN_SEGMENT_SECONDS };
