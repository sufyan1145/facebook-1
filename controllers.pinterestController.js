const env = require('./config.env');
const Log = require('./models.Log');
const PinterestAccount = require('./models.PinterestAccount');
const svc = require('./services.pinterestService');

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    res.status(err.status && err.status < 600 ? (err.status === 401 ? 400 : err.status) : 400).json({ success: false, message: err.message });
  }
};

const connect = wrap(async (req, res) => {
  res.json({ success: true, data: { url: svc.authUrl(req.user.id) } });
});

// Pinterest sends the browser back here; "state" carries the (signed) user id.
async function callback(req, res) {
  const back = (q) => res.redirect(`${env.frontendUrl}/pages.html?${q}`);
  try {
    const { code, state, error } = req.query;
    if (error) return back(`pinterest_error=${encodeURIComponent(String(error))}`);
    const userId = svc.readState(state);
    if (!userId) return back('pinterest_error=' + encodeURIComponent('The login link expired. Press "Add Pinterest" again.'));
    const tokens = await svc.exchangeCode(code);
    const me = await svc.userAccount(tokens.accessToken);
    const acc = await PinterestAccount.upsert(userId, { username: me.username || 'pinterest', ...tokens });
    await Log.record(userId, 'Pinterest Connected', { username: acc.username });
    return back('pinterest_connected=1');
  } catch (err) {
    return back(`pinterest_error=${encodeURIComponent(err.message)}`);
  }
}

const listAccounts = wrap(async (req, res) => {
  res.json({ success: true, data: await PinterestAccount.listByUser(req.user.id), configured: svc.configured() });
});

const boards = wrap(async (req, res) => {
  const acc = await PinterestAccount.findById(req.user.id, req.params.id);
  if (!acc) { const e = new Error('Not found'); e.status = 404; throw e; }
  res.json({ success: true, data: await svc.listBoards(acc) });
});

const setBoard = wrap(async (req, res) => {
  const { boardId, boardName } = req.body || {};
  if (!boardId) throw new Error('Choose a board.');
  const row = await PinterestAccount.setBoard(req.user.id, req.params.id, String(boardId), String(boardName || '').slice(0, 200));
  if (!row) { const e = new Error('Not found'); e.status = 404; throw e; }
  res.json({ success: true, data: row });
});

const remove = wrap(async (req, res) => {
  await PinterestAccount.remove(req.user.id, req.params.id);
  res.json({ success: true });
});

module.exports = { connect, callback, listAccounts, boards, setBoard, remove };
