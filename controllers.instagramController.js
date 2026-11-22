const env = require('./config.env');
const Log = require('./models.Log');
const InstagramAccount = require('./models.InstagramAccount');
const svc = require('./services.instagramLoginService');

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) { res.status(400).json({ success: false, message: err.message }); }
};

const connect = wrap(async (req, res) => { res.json({ success: true, data: { url: svc.authUrl(req.user.id) } }); });

// Instagram sends the browser back here; "state" carries the (signed) user id.
async function callback(req, res) {
  const back = (q) => res.redirect(`${env.frontendUrl}/pages.html?${q}`);
  try {
    const { code, state, error, error_description: desc, error_reason: reason } = req.query;
    if (error) return back(`instagram_error=${encodeURIComponent(String(desc || reason || error))}`);
    const userId = svc.readState(state);
    if (!userId) return back('instagram_error=' + encodeURIComponent('The login link expired. Press "Add Instagram" again.'));
    const t = await svc.exchangeCode(code);
    const me = await svc.profile(t.accessToken);
    const acc = await InstagramAccount.upsert(userId, { username: me.username || 'instagram', igUserId: me.id || t.igUserId, accountType: me.accountType, accessToken: t.accessToken, expiresAt: t.expiresAt });
    await Log.record(userId, 'Instagram Connected', { username: acc.username });
    return back('instagram_connected=1');
  } catch (err) {
    return back(`instagram_error=${encodeURIComponent(err.message)}`);
  }
}

const listAccounts = wrap(async (req, res) => {
  res.json({ success: true, data: await InstagramAccount.listByUser(req.user.id), configured: svc.configured() });
});

const remove = wrap(async (req, res) => {
  await InstagramAccount.remove(req.user.id, req.params.id);
  res.json({ success: true });
});

module.exports = { connect, callback, listAccounts, remove };
