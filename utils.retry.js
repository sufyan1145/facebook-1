const logger = require('./utils.logger');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries a request on HTTP 429 (rate limit), 503 (model overloaded/high
// demand), a plain client-side timeout (no response received at all -
// often the same underlying overload, just slow enough to blow the axios
// timeout before the server even sends a 503), or a transient network-level
// error (DNS lookup blip, connection reset/refused) with increasing backoff
// delays. These network errors are almost always momentary - retrying a few
// seconds later usually succeeds - so failing the whole run on the first
// one (as this used to do) turned a brief blip into a wasted pipeline run.
const RETRYABLE_NETWORK_CODES = new Set(['EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT']);

async function retryOn429(fn, { retries = 4, delaysMs = [15000, 30000, 60000, 90000], label = 'request' } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.response?.status;
      const isTimeout = !status && (err.code === 'ECONNABORTED' || /timeout/i.test(err.message || ''));
      const isNetworkError = !status && RETRYABLE_NETWORK_CODES.has(err.code);
      if ((status === 429 || status === 503 || isTimeout || isNetworkError) && attempt < retries) {
        const wait = delaysMs[attempt] || delaysMs[delaysMs.length - 1];
        const reason = status === 429 ? 'rate-limited' : status === 503 ? 'overloaded/high demand' : isNetworkError ? `network error (${err.code})` : 'timed out (likely overloaded)';
        logger.info(`[retry] ${label} ${status ? `got ${status}` : 'request'} (${reason}), waiting ${wait / 1000}s before retry ${attempt + 1}/${retries}`);
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

module.exports = { retryOn429 };
