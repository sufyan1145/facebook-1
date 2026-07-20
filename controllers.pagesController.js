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

module.exports = { syncPages, listPages, disconnectPage };
