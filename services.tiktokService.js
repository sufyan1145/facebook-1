const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const execFileAsync = util.promisify(execFile);
const logger = require('./utils.logger');

const YTDLP_BIN = process.env.YTDLP_PATH || 'yt-dlp';
const TIMEOUT_MS = 5 * 60 * 1000; // downloads can take a while on slow connections
const TRANSCODE_TIMEOUT_MS = 15 * 60 * 1000; // re-encoding a long video takes longer than just downloading it

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
  await ytdlpDownload(url, rawPath, ['-f', 'b/best', '--no-warnings', '-o', rawPath, url]);

  let hasAudio = await hasAudioStream(rawPath);
  if (!hasAudio) {
    logger.error(`[tiktok] first attempt has no audio, retrying with an explicit audio+video format: ${url}`);
    const explicitFormatId = await findAudioVideoFormatId(url);
    if (explicitFormatId) {
      await ytdlpDownload(url, rawPath, ['-f', explicitFormatId, '--no-warnings', '-o', rawPath, url]);
      hasAudio = await hasAudioStream(rawPath);
    }
  }

  if (!hasAudio) {
    // No single format has both audio and video for this video - some TikTok
    // posts only expose separate video-only and audio-only streams with no
    // combined option at all. Explicitly merge them (yt-dlp does this via
    // ffmpeg, which is already installed) as a last resort before giving up.
    logger.error(`[tiktok] no combined format available, trying an explicit bestvideo+bestaudio merge: ${url}`);
    try {
      await ytdlpDownload(url, rawPath, [
        '-f', 'bestvideo*+bestaudio/bestvideo+bestaudio',
        '--merge-output-format', 'mp4',
        '--no-warnings', '-o', rawPath, url,
      ]);
      hasAudio = await hasAudioStream(rawPath);
    } catch (mergeErr) {
      logger.error(`[tiktok] explicit merge attempt failed: ${mergeErr.message}`);
    }
  }

  if (!hasAudio) {
    logger.error(`[tiktok] still no audio after all fallbacks - this TikTok video may genuinely have no sound: ${url}`);
  }

  // Most TikTok videos are already h264(+aac) - a full libx264 re-encode is
  // unnecessary CPU/memory-heavy work for those, and was likely why longer/
  // heavier videos got silently killed (no ffmpeg error text at all, just
  // "Command failed" - a classic sign of an out-of-memory kill). Only
  // re-encode whichever stream(s) actually need it; copy the rest.
  const codecs = await getCodecs(rawPath);
  const videoNeedsEncode = codecs.video !== 'h264';
  const audioNeedsEncode = hasAudio && codecs.audio !== 'aac';

  try {
    await execFileAsync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-nostats',
      '-i', rawPath,
      ...(videoNeedsEncode ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'] : ['-c:v', 'copy']),
      ...(!hasAudio ? ['-an'] : audioNeedsEncode ? ['-c:a', 'aac', '-b:a', '128k'] : ['-c:a', 'copy']),
      '-movflags', '+faststart',
      destPath,
    ], { timeout: videoNeedsEncode ? TRANSCODE_TIMEOUT_MS : TIMEOUT_MS, maxBuffer: 1024 * 1024 * 50 });
  } catch (err) {
    logger.error(`[tiktok] transcode failed for ${url}: ${err.stderr || err.message}`);
    throw new Error('Downloaded the video but failed to convert it to a playable format.');
  } finally {
    fs.unlink(rawPath, () => {});
  }

  return destPath;
}

// Reads each stream's codec so downloadVideo can skip re-encoding whatever's
// already in a broadly-compatible format.
async function getCodecs(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name',
      '-of', 'csv=p=0',
      filePath,
    ]);
    const codecs = { video: null, audio: null };
    stdout.trim().split('\n').filter(Boolean).forEach((line) => {
      const [codecType, codecName] = line.split(',');
      if (codecType === 'video' && !codecs.video) codecs.video = codecName;
      if (codecType === 'audio' && !codecs.audio) codecs.audio = codecName;
    });
    return codecs;
  } catch (err) {
    logger.error(`[tiktok] ffprobe codec check failed for ${filePath}: ${err.message}`);
    return { video: null, audio: null }; // treat as "needs encoding" if we can't tell
  }
}

async function ytdlpDownload(url, rawPath, args) {
  try {
    await execFileAsync(YTDLP_BIN, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 * 20 });
  } catch (err) {
    logger.error(`[tiktok] download failed for ${url}: ${err.stderr || err.message}`);
    throw new Error('Failed to download this TikTok video.');
  }
}

// Inspects the raw format list (bypassing selector shorthand entirely) to find
// one format ID that genuinely has BOTH a video and an audio codec - used as
// a fallback when the default selector's output has no audio.
async function findAudioVideoFormatId(url) {
  try {
    const { stdout } = await execFileAsync(
      YTDLP_BIN,
      ['--dump-json', '--no-warnings', '--skip-download', url],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 * 20 }
    );
    const data = JSON.parse(stdout.trim().split('\n')[0]);
    const formats = Array.isArray(data.formats) ? data.formats : [];
    const combined = formats.filter(
      (f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none'
    );
    if (!combined.length) return null;
    combined.sort((a, b) => (b.tbr || 0) - (a.tbr || 0));
    return combined[0].format_id || null;
  } catch (err) {
    logger.error(`[tiktok] could not inspect format list for ${url}: ${err.stderr || err.message}`);
    return null;
  }
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
