const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./utils.logger');

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) {
        logger.error(`[ffmpeg] failed: ${stderr?.slice(-2000) || err.message}`);
        return reject(new Error(`ffmpeg failed: ${err.message}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

// Concatenates video clips (same codec/resolution expected) into one file.
async function concatClips(clipPaths, outputPath) {
  const listPath = outputPath.replace(/\.mp4$/, '.txt');
  const listContent = clipPaths.map((p) => `file '${path.resolve(p).replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listPath, listContent);

  await run(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-an', outputPath]);
  fs.unlinkSync(listPath);
  return outputPath;
}

// Lays the voiceover audio track over the stitched video, trimming to the shorter of the two.
async function mergeAudioVideo(videoPath, audioPath, outputPath) {
  await run([
    '-y', '-i', videoPath, '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-shortest', outputPath,
  ]);
  return outputPath;
}

module.exports = { concatClips, mergeAudioVideo };
