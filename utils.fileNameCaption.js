/**
 * Turns a Drive file name into readable caption text.
 *   "She_Realizes_She_Controls_a_Giant_Monster!_😱_6fa0bff6.mp4"
 *     -> "She Realizes She Controls a Giant Monster! 😱"
 * - drops the extension
 * - drops the "_<8 hex chars>" job-id suffix the Video Editor appends
 * - underscores -> spaces, repeated spaces collapsed
 * Returns '' when nothing readable is left (e.g. "edited_6fa0bff6.mp4").
 */
function captionFromFileName(name) {
  let s = String(name || '').replace(/\.[^.\\/]{1,5}$/, '');
  s = s.replace(/_[0-9a-f]{8}$/i, '');
  s = s.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(edited|video|untitled)$/i.test(s)) return '';
  return s;
}

module.exports = { captionFromFileName };
