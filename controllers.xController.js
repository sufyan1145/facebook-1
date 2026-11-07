const Log = require('./models.Log');
const XAccount = require('./models.XAccount');
const xService = require('./services.xService');

const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) { next(err); }
};

const listAccounts = wrap(async (req, res) => {
  res.json({ success: true, data: await XAccount.listByUser(req.user.id) });
});

// Verifies the cookies against X first - nothing is saved unless they really work.
const addAccount = wrap(async (req, res) => {
  let cookies;
  try { cookies = xService.parseCookies(req.body || {}); }
  catch (err) { return res.status(400).json({ success: false, message: err.message }); }
  let info;
  try { info = await xService.verify(cookies); }
  catch (err) { return res.status(400).json({ success: false, message: `X did not accept these cookies: ${err.message}` }); }
  const acc = await XAccount.upsert(req.user.id, { ...info, authToken: cookies.authToken, ct0: cookies.ct0 });
  await Log.record(req.user.id, 'X Account Connected', { username: info.username });
  res.status(201).json({ success: true, data: acc });
});

// "Check" button: are the saved cookies still alive?
const checkAccount = wrap(async (req, res) => {
  const acc = await XAccount.findById(req.user.id, req.params.id);
  if (!acc) return res.status(404).json({ success: false, message: 'Account not found' });
  try {
    await xService.verify({ authToken: acc.auth_token, ct0: acc.ct0 });
    await XAccount.markUsed(acc.id);
    res.json({ success: true, message: 'Cookies are working.' });
  } catch (err) {
    await XAccount.markExpired(acc.id, err.message);
    res.status(400).json({ success: false, message: err.message });
  }
});

const removeAccount = wrap(async (req, res) => {
  await XAccount.remove(req.user.id, req.params.id);
  await Log.record(req.user.id, 'X Account Disconnected', { accountId: req.params.id });
  res.json({ success: true });
});

module.exports = { listAccounts, addAccount, checkAccount, removeAccount };
