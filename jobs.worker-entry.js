/**
 * Entry point for running background workers as a separate PM2 process.
 * Run with: pm2 start jobs.worker-entry.js --name d2f-workers
 */
require('./jobs.uploadWorker'); // Worker 3: Facebook Upload
const { startScheduleChecker } = require('./jobs.scheduleChecker'); // Worker 1 + 2 (drive scan happens inline)
const { startCleanupWorker } = require('./jobs.cleanupWorker'); // Worker 5
const { startVideoGenWorker } = require('./jobs.videoGenWorker'); // Worker 6: AI Video Generation
const { startContentPipelineWorker } = require('./jobs.contentPipelineWorker'); // Worker 7: Automated Content Pipeline
const logger = require('./utils.logger');

startScheduleChecker();
startCleanupWorker();
startVideoGenWorker();
startContentPipelineWorker();

logger.info('All background workers started (Schedule Checker, Drive Scanner, Facebook Upload, Cleanup, Video Generation, Content Pipeline).');
logger.info('Notification Service runs inline within the upload worker (Worker 4).');
