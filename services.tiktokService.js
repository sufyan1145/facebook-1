const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
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

// Downloads the actual video file. Explicitly selects and merges the best
// video AND best audio streams (falls back to a single combined "best" only
// if separate streams aren't available) - the previous 'mp4/best' selector
// could pick a video-only TikTok CDN stream with no audio track at all.
// The merged file is then transcoded to a standard H.264+AAC MP4, so it plays
// reliably everywhere (Drive preview, any media player, Facebook/YouTube
// upload) instead of depending on whatever codec TikTok happened to serve.
async function downloadVideo(url, destPath) {
  const rawPath = destPath.replace(/\.mp4$/, '_raw.mp4');
  try {
    await execFileAsync(
      YTDLP_BIN,
      ['-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4', '--no-warnings', '-o', rawPath, url],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 * 20 }
    );
  } catch (err) {
    logger.error(`[tiktok] download failed for ${url}: ${err.stderr || err.message}`);
    throw new Error('Failed to download this TikTok video.');
  }

  const hasAudio = await hasAudioStream(rawPath);
  if (!hasAudio) {
    logger.error(`[tiktok] downloaded file has no audio stream: ${rawPath} (source: ${url})`);
  }

  try {
    await execFileAsync('ffmpeg', [
      '-y', '-i', rawPath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
      '-movflags', '+faststart',
      destPath,
    ], { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 * 20 });
  } catch (err) {
    logger.error(`[tiktok] transcode failed for ${url}: ${err.stderr || err.message}`);
    throw new Error('Downloaded the video but failed to convert it to a playable format.');
  } finally {
    fs.unlink(rawPath, () => {});
  }

  return destPath;
}

// Quick ffprobe check so a silent download is at least logged, not silently
// passed along as if everything were fine.
async function hasAudioStream(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream=codec_type',
      '-of', 'csv=p=0',
      filePath,
    ]);
    return stdout.trim().length > 0;
  } catch (err) {
    logger.error(`[tiktok] ffprobe audio check failed for ${filePath}: ${err.message}`);
    return true; // don't block completion just because the check itself failed
  }
}

module.exports = { isTikTokUrl, getMetadata, downloadVideo };
