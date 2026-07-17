/**
 * Simple migration runner - executes all migrations.*.sql files in order.
 * Usage: node migrate-runner.js
 */
const fs = require('fs');
const path = require('path');
const { pool } = require('./config.database');
const logger = require('./utils.logger');

async function run() {
  const files = fs
    .readdirSync(__dirname)
    .filter((f) => f.startsWith('migrations.') && f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(__dirname, file), 'utf8');
    logger.info(`Running migration: ${file}`);
    await pool.query(sql);
    logger.info(`Completed migration: ${file}`);
  }

  logger.info('All migrations completed.');
  await pool.end();
  process.exit(0);
}

run().catch((err) => {
  logger.error(`Migration failed: ${err.message}`);
  process.exit(1);
});
