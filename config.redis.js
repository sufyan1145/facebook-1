const IORedis = require('ioredis');
const env = require('./config.env');
const logger = require('./utils.logger');

const connection = new IORedis({
  host: env.redis.host,
  port: env.redis.port,
  password: env.redis.password,
  maxRetriesPerRequest: null, // required by BullMQ
});

connection.on('connect', () => logger.info('Connected to Redis'));
connection.on('error', (err) => logger.error(`Redis error: ${err.message}`));

module.exports = connection;
