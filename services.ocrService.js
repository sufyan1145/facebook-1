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

// Returns the extracted text (trimmed), or an empty string if OCR finds
// nothing / fails for any reason - never throws, so it's always safe to call
// right before posting without risking the whole post.
async function extractTextFromImage(imagePath) {
  try {
    const { data } = await Tesseract.recognize(imagePath, 'eng');
    return (data.text || '').trim();
  } catch (err) {
    logger.warn(`[ocrService] Text extraction failed (${err.message}) - continuing without a caption`);
    return '';
  }
}

module.exports = { extractTextFromImage };
