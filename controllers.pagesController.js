const facebookService = require('./services.facebookService');
const FacebookToken = require('./models.FacebookToken');
const Page = require('./models.Page');
const Log = require('./models.Log');

async function syncPages(req, res, next) {
  try {
    const { accountId } = req.body || {};
    const accounts = accountId
      ? [{ id: accountId }]
      : await FacebookToken.listByUser(req.user.id); // no accountId given -> refresh every connected account

    let saved = [];
    for (const account of accounts) {
      const pages = await facebookService.getUserPages(req.user.id, account.id);
      saved = saved.concat(await Page.upsertMany(req.user.id, account.id, pages));
    }
    res.json({ success: true, data: saved });
  } catch (err) {
    next(err);
  }
}

// Paid users (and admins) can connect Pages directly with a Page access token - no Facebook login / tester needed.
const MAX_BATCH = 50;
async function addByToken(req, res, next) {
  try {
    if (!(req.user.isAdmin || req.user.planType === 'paid')) {
      return res.status(403).json({ success: false, message: 'Adding Pages by token is available on paid plans.' });
    }
    const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ success: false, message: 'Nothing to add.' });
    if (items.length > MAX_BATCH) return res.status(400).json({ success: false, message: `Send at most ${MAX_BATCH} pages per request.` });

    const results = new Array(items.length);
    let next_ = 0;
    const worker = async () => {
      while (next_ < items.length) {
        const i = next_++;
        const it = items[i] || {};
        const token = String(it.token || '').trim();
        const wantId = it.id ? String(it.id).trim() : '';
        try {
          if (token.length < 20) throw new Error('Token missing or too short.');
          const page = await facebookService.getPageByToken(token);
          if (wantId && wantId !== page.id) throw new Error(`Token belongs to a different page (${page.id}).`);
          await Page.upsertByToken(req.user.id, page);
          results[i] = { ok: true, id: page.id, name: page.name };
        } catch (err) {
          results[i] = { ok: false, id: wantId || undefined, error: String(err.message || err).slice(0, 200) };
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    const added = results.filter((r) => r.ok).length;
    if (added) await Log.record(req.user.id, 'Pages Added By Token', { added, failed: results.length - added });
    res.json({ success: true, data: results });
  } catch (err) {
    next(err);
  }
}

async function listPages(req, res, next) {
  try {
    const pages = await Page.listByUser(req.user.id);
    res.json({ success: true, data: pages });
  } catch (err) {
    next(err);
  }
}

async function disconnectPage(req, res, next) {
  try {
    await Page.disconnect(req.user.id, req.params.id);
    await Log.record(req.user.id, 'Page Disconnected', { pageId: req.params.id });
    res.json({ success: true, message: 'Page disconnected' });
  } catch (err) {
    next(err);
  }
}

module.exports = { syncPages, listPages, disconnectPage, addByToken };
