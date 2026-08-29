/**
 * Fallback title generation for the Video Editor's Drive filenames.
 *
 * When AI title regeneration (Gemini) is unavailable - hit its quota, a
 * network error, a bad response, etc - we still want the saved file to
 * carry a meaningful, human-readable name instead of a generic
 * "edited_<jobId>.mp4". This reorders the *original* source title's own
 * words into a different but still readable order, rather than inventing
 * new wording (which needs the very AI call that just failed).
 */

// Common separators used in video titles ("Clip A | Reaction", "Part 1 - The
// Reveal", "Recipe: Perfect Pancakes"). Swapping the two sides usually keeps
// each half grammatically intact, since each half was already a
// self-contained phrase.
const SEPARATORS = [' | ', ' — ', ' – ', ' - ', ': ', ' • '];

function reorderTitleWords(title) {
  const trimmed = (title || '').trim();
  if (!trimmed) return null;

  for (const sep of SEPARATORS) {
    const idx = trimmed.indexOf(sep);
    if (idx > 0) {
      const left = trimmed.slice(0, idx).trim();
      const right = trimmed.slice(idx + sep.length).trim();
      if (left && right) return `${right}${sep}${left}`;
    }
  }

  // No separator found: rotate words - move the back half of the sentence
  // in front of the front half. E.g. "How To Bake A Perfect Cake" becomes
  // "A Perfect Cake How To Bake". This is a simple heuristic (not real
  // grammar analysis), but it keeps existing word groupings together and
  // reads far better than a random shuffle.
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 4) return trimmed; // too short to reorder meaningfully
  const mid = Math.ceil(words.length / 2);
  return [...words.slice(mid), ...words.slice(0, mid)].join(' ');
}

// Makes a string safe to use as (part of) a filename / Drive file name:
// strips characters that are illegal or awkward on common filesystems and
// in Drive's UI, collapses whitespace to underscores, and caps the length
// so we don't hit filesystem path-length limits.
function sanitizeForFilename(text, maxLength = 80) {
  if (!text) return null;
  const cleaned = text
    .replace(/[\\/:*?"<>|]/g, '') // illegal on Windows/most filesystems
    .replace(/[\u0000-\u001f]/g, '') // control characters
    .trim()
    .replace(/\s+/g, '_');
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

module.exports = { reorderTitleWords, sanitizeForFilename };
