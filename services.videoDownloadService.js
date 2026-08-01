/**
 * Downloads a video from ANY yt-dlp-supported site (YouTube, TikTok,
 * Snapchat, Instagram, Twitter/X, Facebook, etc. - yt-dlp supports
 * 1000+ sites) for the Video Editor feature. Reuses the same
 * battle-tested audio-fallback + memory-safe transcode approach built
 * for the TikTok Downloader.
 */
const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs');
const execFileAsync = util.promisify(execFile);
const logger = require('./utils.logger');

const YTDLP_BIN = process.env.YTDLP_PATH || 'yt-dlp';
const TIMEOUT_MS = 8 * 60 * 1000;
const TRANSCODE_TIMEOUT_MS = 15 * 60 * 1000;

function isValidUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

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
      durationSeconds: data.duration || null,
    };
  } catch (err) {
    logger.error(`[videodl] metadata fetch failed for ${url}: ${err.stderr || err.message}`);
    throw new Error('Could not read this video link - it may be private, deleted, region-locked, or the site is not supported.');
  }
}

async function ytdlpDownload(url, rawPath, args) {
  try {
    await execFileAsync(YTDLP_BIN, args, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 * 20 });
  } catch (err) {
    logger.error(`[videodl] download failed for ${url}: ${err.stderr || err.message}`);
    throw new Error('Failed to download this video.');
  }
}

async function hasAudioStream(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', filePath,
    ]);
    return stdout.trim().length > 0;
  } catch (err) {
    logger.error(`[videodl] ffprobe audio check failed for ${filePath}: ${err.message}`);
    return true;
  }
}

async function getCodecs(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', filePath,
    ]);
    const codecs = { video: null, audio: null };
    stdout.trim().split('\n').filter(Boolean).forEach((line) => {
      const [codecType, codecName] = line.split(',');
      if (codecType === 'video' && !codecs.video) codecs.video = codecName;
      if (codecType === 'audio' && !codecs.audio) codecs.audio = codecName;
    });
    return codecs;
  } catch (err) {
    logger.error(`[videodl] ffprobe codec check failed for ${filePath}: ${err.message}`);
    return { video: null, audio: null };
  }
}

async function findAudioVideoFormatId(url) {
  try {
    const { stdout } = await execFileAsync(YTDLP_BIN, ['--dump-json', '--no-warnings', '--skip-download', url], {
      timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 * 20,
    });
    const data = JSON.parse(stdout.trim().split('\n')[0]);
    const formats = Array.isArray(data.formats) ? data.formats : [];
    const combined = formats.filter((f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none');
    if (!combined.length) return null;
    combined.sort((a, b) => (b.tbr || 0) - (a.tbr || 0));
    return combined[0].format_id || null;
  } catch (err) {
    logger.error(`[videodl] could not inspect format list for ${url}: ${err.stderr || err.message}`);
    return null;
  }
}

async function downloadVideo(url, destPath) {
  const rawPath = destPath.replace(/\.mp4$/, '_raw.mp4');
  await ytdlpDownload(url, rawPath, ['-f', 'b/best', '--no-warnings', '-o', rawPath, url]);

  let hasAudio = await hasAudioStream(rawPath);
  if (!hasAudio) {
    const explicitFormatId = await findAudioVideoFormatId(url);
    if (explicitFormatId) {
      await ytdlpDownload(url, rawPath, ['-f', explicitFormatId, '--no-warnings', '-o', rawPath, url]);
      hasAudio = await hasAudioStream(rawPath);
    }
  }
  if (!hasAudio) {
    try {
      await ytdlpDownload(url, rawPath, [
        '-f', 'bestvideo*+bestaudio/bestvideo+bestaudio', '--merge-output-format', 'mp4', '--no-warnings', '-o', rawPath, url,
      ]);
      hasAudio = await hasAudioStream(rawPath);
    } catch (mergeErr) {
      logger.error(`[videodl] explicit merge attempt failed: ${mergeErr.message}`);
    }
  }

  const codecs = await getCodecs(rawPath);
  const videoNeedsEncode = codecs.video !== 'h264';
  const audioNeedsEncode = hasAudio && codecs.audio !== 'aac';

  try {
    await execFileAsync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-nostats',
      '-i', rawPath,
      ...(videoNeedsEncode
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', '2', '-x264-params', 'rc-lookahead=20:ref=2']
        : ['-c:v', 'copy']),
      ...(!hasAudio ? ['-an'] : audioNeedsEncode ? ['-c:a', 'aac', '-b:a', '128k'] : ['-c:a', 'copy']),
      '-movflags', '+faststart',
      destPath,
    ], { timeout: videoNeedsEncode ? TRANSCODE_TIMEOUT_MS : TIMEOUT_MS, maxBuffer: 1024 * 1024 * 50 });
  } catch (err) {
    logger.error(`[videodl] transcode failed for ${url}: ${err.stderr || err.message}`);
    throw new Error('Downloaded the video but failed to convert it to a playable format.');
  } finally {
    fs.unlink(rawPath, () => {});
  }

  return destPath;
}

module.exports = { isValidUrl, getMetadata, downloadVideo };
