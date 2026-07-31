const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const logger = require('./utils.logger');

const YTDLP_BIN = process.env.YTDLP_PATH || 'yt-dlp';
const TIMEOUT_MS = 5 * 60 * 1000; // downloads can take a while on slow connections

function isTikTokUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return host === 'tiktok.com' || host.endsWith('.tiktok.com') || host === 'vm.tiktok.com';
  } catch {
    return false;
  }
}

// Fetches title/description/uploader WITHOUT downloading the video - used to
// feed the original caption into Gemini for rewriting.
async function getMetadata(url) {
  try {
    const { stdout } = await execFileAsync(
      YTDLP_BIN,
      ['--dump-json', '--no-warnings', '--skip-download', url],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 * 20 }
    );
    const data = JSON.parse(stdout.trim().split('\n')[0]);
    return {
      title: data.title || '',
      description: data.description || '',
      uploader: data.uploader || data.uploader_id || '',
      durationSeconds: data.duration || null,
    };
  } catch (err) {
    logger.error(`[tiktok] metadata fetch failed for ${url}: ${err.stderr || err.message}`);
    throw new Error('Could not read this TikTok link - it may be private, deleted, or region-locked.');
  }
}

// Downloads the actual video file (best available quality, remuxed to mp4,
// without TikTok's watermark overlay where yt-dlp's extractor supports it).
async function downloadVideo(url, destPath) {
  try {
    await execFileAsync(
      YTDLP_BIN,
      ['-f', 'mp4/best', '--remux-video', 'mp4', '--no-warnings', '-o', destPath, url],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 * 20 }
    );
    return destPath;
  } catch (err) {
    logger.error(`[tiktok] download failed for ${url}: ${err.stderr || err.message}`);
    throw new Error('Failed to download this TikTok video.');
  }
}

module.exports = { isTikTokUrl, getMetadata, downloadVideo };
