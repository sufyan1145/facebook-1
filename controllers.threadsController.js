const env = require('./config.env');
const Log = require('./models.Log');
const ThreadsAccount = require('./models.ThreadsAccount');
const svc = require('./services.threadsService');

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    res.status(err.status && err.status < 600 ? (err.status === 401 ? 400 : err.status) : 400).json({ success: false, message: err.message });
  }
};

const connect = wrap(async (req, res) => {
  res.json({ success: true, data: { url: svc.authUrl(req.user.id) } });
});

// Threads sends the browser back here; "state" carries the (signed) user id.
async function callback(req, res) {
  const back = (q) => res.redirect(`${env.frontendUrl}/pages.html?${q}`);
  try {
    const { code, state, error, error_description: desc } = req.query;
    if (error) return back(`threads_error=${encodeURIComponent(String(desc || error))}`);
    const userId = svc.readState(state);
    if (!userId) return back('threads_error=' + encodeURIComponent('The login link expired. Press "Add Threads" again.'));
    const t = await svc.exchangeCode(code);
    const me = await svc.profile(t.accessToken);
    const acc = await ThreadsAccount.upsert(userId, { username: me.username || 'threads', threadsUserId: me.id || t.threadsUserId, accessToken: t.accessToken, expiresAt: t.expiresAt });
    await Log.record(userId, 'Threads Connected', { username: acc.username });
    return back('threads_connected=1');
  } catch (err) {
    return back(`threads_error=${encodeURIComponent(err.message)}`);
  }
}

const listAccounts = wrap(async (req, res) => {
  res.json({ success: true, data: await ThreadsAccount.listByUser(req.user.id), configured: svc.configured() });
});

const remove = wrap(async (req, res) => {
  await ThreadsAccount.remove(req.user.id, req.params.id);
  res.json({ success: true });
});

module.exports = { connect, callback, listAccounts, remove };
