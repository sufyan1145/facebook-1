const Notification = require('./models.Notification');

async function list(req, res, next) {
  try {
    const rows = await Notification.listByUser(req.user.id);
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

async function markRead(req, res, next) {
  try {
    await Notification.markRead(req.user.id, req.params.id);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, markRead };
