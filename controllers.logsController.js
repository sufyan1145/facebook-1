const Log = require('./models.Log');

async function list(req, res, next) {
  try {
    const { limit, offset } = req.query;
    const rows = await Log.listByUser(req.user.id, { limit: Number(limit) || 100, offset: Number(offset) || 0 });
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

module.exports = { list };
