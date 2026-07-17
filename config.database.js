const { Pool } = require('pg');
const env = require('./config.env');
const logger = require('./utils.logger');

const pool = new Pool({
  connectionString: env.db.connectionString,
});

pool.on('error', (err) => {
  logger.error(`Unexpected PostgreSQL error: ${err.message}`);
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  logger.debug(`Query executed in ${duration}ms: ${text}`);
  return res;
}

module.exports = { pool, query };
