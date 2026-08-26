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
const os = require('os');
const path = require('path');
const execFileAsync = util.promisify(execFile);
const logger = require('./utils.logger');
const env = require('./config.env');

const YTDLP_BIN = process.env.YTDLP_PATH || 'yt-dlp';
const TIMEOUT_MS = 8 * 60 * 1000;
const TRANSCODE_TIMEOUT_MS = 15 * 60 * 1000;

// Lazily decode YTDLP_COOKIES_BASE64 (if set) to a cookies.txt file once,
// and reuse that same file for every yt-dlp call. This is the standard
// yt-dlp workaround for YouTube's "Sign in to confirm you're not a bot"
// anti-bot block, which cloud/datacenter IPs (like Railway's) commonly hit.
let cookiesFilePath = null;
let cookiesFileChecked = false;
function getCookiesArgs() {
  if (!cookiesFileChecked) {
    cookiesFileChecked = true;
    if (env.videoDownload?.cookiesBase64) {
      try {
        const p = path.join(os.tmpdir(), 'ytdlp-cookies.txt');
        fs.writeFileSync(p, Buffer.from(env.videoDownload.cookiesBase64, 'base64'));
        cookiesFilePath = p;
        logger.info('[videodl] loaded YouTube cookies from YTDLP_COOKIES_BASE64');
      } catch (err) {
        logger.error(`[videodl] failed to decode YTDLP_COOKIES_BASE64: ${err.message}`);
      }
    }
  }
  return cookiesFilePath ? ['--cookies', cookiesFilePath] : [];
}

// Browser-fingerprint spoofing - several sites (Facebook's "Cannot parse
// data" error, YouTube bot-detection) now expect a realistic TLS/HTTP
// fingerprint. The musllinux x86_64 build bundles curl_cffi so this works
// without extra setup; if it's ever missing, yt-dlp just warns and
// continues rather than failing the whole download.
let impersonateChecked = false;
function getImpersonateArgs() {
  if (!impersonateChecked) {
    impersonateChecked = true;
    execFile(YTDLP_BIN, ['--list-impersonate-targets'], (err, stdout) => {
      logger.info(`[videodl] impersonate targets check: ${(stdout || err?.message || '').trim().replace(/\n/g, ' | ')}`);
    });
  }
  return ['--impersonate', 'chrome'];
}

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
      [...getCookiesArgs(), ...getImpersonateArgs(), '--dump-json', '--no-warnings', '--skip-download', url],
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
    const message = err.stderr || err.message || '';
    // Known open yt-dlp/YouTube bug (yt-dlp/yt-dlp#17389): passing cookies to
    // YouTube can force a broken "tv_downgraded" player client, which fails
    // with "The page needs to be reloaded." Retrying once without cookies and
    // with an explicit player_client works around it until upstream patches it.
    const isReloadBug = /page needs to be reloaded/i.test(message);
    if (isReloadBug) {
      logger.error(`[videodl] hit known yt-dlp "page needs to be reloaded" bug for ${url}, retrying with player_client workaround`);
      const retryArgs = args
        .filter((a, i) => a !== '--cookies' && args[i - 1] !== '--cookies')
        .concat(['--extractor-args', 'youtube:player_client=default,web_embedded']);
      try {
        await execFileAsync(YTDLP_BIN, retryArgs, { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 * 20 });
        return;
      } catch (retryErr) {
        logger.error(`[videodl] retry after reload-bug workaround also failed for ${url}: ${retryErr.stderr || retryErr.message}`);
        throw new Error('Failed to download this video.');
      }
    }
    logger.error(`[videodl] download failed for ${url}: ${message}`);
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
    const { stdout } = await execFileAsync(YTDLP_BIN, [...getCookiesArgs(), ...getImpersonateArgs(), '--dump-json', '--no-warnings', '--skip-download', url], {
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
  const cookiesArgs = getCookiesArgs();
  const impersonateArgs = getImpersonateArgs();
  await ytdlpDownload(url, rawPath, [...cookiesArgs, ...impersonateArgs, '-f', 'b/best', '--no-warnings', '-o', rawPath, url]);

  let hasAudio = await hasAudioStream(rawPath);
  if (!hasAudio) {
    const explicitFormatId = await findAudioVideoFormatId(url);
    if (explicitFormatId) {
      await ytdlpDownload(url, rawPath, [...cookiesArgs, ...impersonateArgs, '-f', explicitFormatId, '--no-warnings', '-o', rawPath, url]);
      hasAudio = await hasAudioStream(rawPath);
    }
  }
  if (!hasAudio) {
    try {
      await ytdlpDownload(url, rawPath, [
        ...cookiesArgs, ...impersonateArgs, '-f', 'bestvideo*+bestaudio/bestvideo+bestaudio', '--merge-output-format', 'mp4', '--no-warnings', '-o', rawPath, url,
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
