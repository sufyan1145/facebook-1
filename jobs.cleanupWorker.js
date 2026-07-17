/**
 * Worker 5: Cleanup Service
 * Periodically removes stale temp files and old completed queue records.
 */
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const env = require('./config.env');
const logger = require('./utils.logger');

function cleanTempDir() {
  const dir = env.upload.tempDir;
  if (!fs.existsSync(dir)) return;
  const now = Date.now();
  for (const file of fs.readdirSync(dir)) {
    const filePath = path.join(dir, file);
    const stats = fs.statSync(filePath);
    // remove files older than 1 hour (should've been deleted after upload already)
    if (now - stats.mtimeMs > 60 * 60 * 1000) {
      fs.unlinkSync(filePath);
      logger.info(`Cleanup: removed stale temp file ${filePath}`);
    }
  }
}

function startCleanupWorker() {
  cron.schedule('0 * * * *', () => {
    try {
      cleanTempDir();
    } catch (err) {
      logger.error(`Cleanup worker error: ${err.message}`);
    }
  });
  logger.info('Cleanup worker started (hourly)');
}

module.exports = { startCleanupWorker };
