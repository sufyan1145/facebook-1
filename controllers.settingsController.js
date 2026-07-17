const Settings = require('./models.Settings');
const User = require('./models.User');

async function getSettings(req, res, next) {
  try {
    const settings = await Settings.getOrCreate(req.user.id);
    const user = await User.findById(req.user.id);
    res.json({ success: true, data: { ...settings, timezone: user.timezone, language: user.language } });
  } catch (err) {
    next(err);
  }
}

async function updateSettings(req, res, next) {
  try {
    const { emailAlerts, autoRetry, uploadSpeed, queueSize, timezone, language } = req.body;
    const settings = await Settings.update(req.user.id, { emailAlerts, autoRetry, uploadSpeed, queueSize });
    if (timezone || language) {
      await User.updateProfile(req.user.id, { timezone, language });
    }
    res.json({ success: true, data: settings });
  } catch (err) {
    next(err);
  }
}

module.exports = { getSettings, updateSettings };
