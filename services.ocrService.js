/**
 * Extracts text written inside an image (OCR), used as a fallback caption
 * source for Text+Image Post when neither a manual "Post Text" nor an
 * AI-generated caption exists - whatever text is baked into the image itself
 * becomes the post's caption.
 * Uses tesseract.js (free, runs locally, no API key/billing) so this never
 * adds any cost.
 */
const Tesseract = require('tesseract.js');
const logger = require('./utils.logger');

const MIN_WORD_CONFIDENCE = 65; // 0-100 - discards low-confidence noise (small background text, watermarks, texture Tesseract misreads as characters)

// Returns the extracted text (trimmed), or an empty string if OCR finds
// nothing / fails for any reason - never throws, so it's always safe to call
// right before posting without risking the whole post.
async function extractTextFromImage(imagePath) {
  try {
    const { data } = await Tesseract.recognize(imagePath, 'eng');

    // Raw data.text often includes low-confidence garbage picked up from
    // small/background text elsewhere in the image. Reconstruct the caption
    // from only the words Tesseract is actually confident about instead.
    const words = data.words || [];
    if (!words.length) return (data.text || '').trim();

    const kept = words.filter((w) => (w.confidence ?? 0) >= MIN_WORD_CONFIDENCE).map((w) => w.text);
    return kept.join(' ').replace(/\s+/g, ' ').trim();
  } catch (err) {
    logger.warn(`[ocrService] Text extraction failed (${err.message}) - continuing without a caption`);
    return '';
  }
}

module.exports = { extractTextFromImage };
