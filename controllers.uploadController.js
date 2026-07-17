const UploadHistory = require('./models.UploadHistory');

async function history(req, res, next) {
  try {
    const { limit, offset } = req.query;
    const rows = await UploadHistory.listByUser(req.user.id, {
      limit: Number(limit) || 50,
      offset: Number(offset) || 0,
    });
    res.json({ success: true, data: rows });
  } catch (err) {
    next(err);
  }
}

module.exports = { history };
