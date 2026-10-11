const chatService = require('./services.chatService');

// Simple per-user limit: 20 messages / 10 minutes (in memory, per server process).
const WINDOW_MS = 10 * 60 * 1000;
const MAX_MSGS = 20;
const hits = new Map();

function allowed(userId) {
  const now = Date.now();
  const arr = (hits.get(userId) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_MSGS) { hits.set(userId, arr); return false; }
  arr.push(now);
  hits.set(userId, arr);
  return true;
}

async function send(req, res, next) {
  try {
    const { messages, page, errorText } = req.body || {};
    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ success: false, message: 'Message is required' });
    }
    if (!allowed(req.user.id)) {
      return res.status(429).json({ success: false, message: 'Too many messages. Please wait a few minutes and try again.' });
    }
    const reply = await chatService.chat({
      user: req.user,
      messages,
      pageName: typeof page === 'string' ? page.slice(0, 60) : '',
      errorText: typeof errorText === 'string' ? errorText.slice(0, 4000) : '',
    });
    res.json({ success: true, data: { reply } });
  } catch (err) {
    next(err);
  }
}

module.exports = { send };
