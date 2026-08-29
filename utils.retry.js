const logger = require('./utils.logger');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries a request on HTTP 429 (rate limit), 503 (model overloaded/high
// demand), or a plain client-side timeout (no response received at all -
// often the same underlying overload, just slow enough to blow the axios
// timeout before the server even sends a 503) with increasing backoff delays.
async function retryOn429(fn, { retries = 4, delaysMs = [15000, 30000, 60000, 90000], label = 'request' } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const isTimeout = !status && (err.code === 'ECONNABORTED' || /timeout/i.test(err.message || ''));
      if ((status === 429 || status === 503 || isTimeout) && attempt < retries) {
        const wait = delaysMs[attempt] || delaysMs[delaysMs.length - 1];
        const reason = status === 429 ? 'rate-limited' : status === 503 ? 'overloaded/high demand' : 'timed out (likely overloaded)';
        logger.info(`[retry] ${label} ${status ? `got ${status}` : 'request'} (${reason}), waiting ${wait / 1000}s before retry ${attempt + 1}/${retries}`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

module.exports = { retryOn429 };
