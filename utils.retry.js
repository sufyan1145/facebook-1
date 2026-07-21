const logger = require('./utils.logger');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries a request on HTTP 429 (rate limit) with increasing backoff delays.
async function retryOn429(fn, { retries = 4, delaysMs = [15000, 30000, 60000, 90000], label = 'request' } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < retries) {
        const wait = delaysMs[attempt] || delaysMs[delaysMs.length - 1];
        logger.info(`[retry] ${label} rate-limited (429), waiting ${wait / 1000}s before retry ${attempt + 1}/${retries}`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

module.exports = { retryOn429 };
