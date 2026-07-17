const Notification = require('./models.Notification');
const Settings = require('./models.Settings');
const User = require('./models.User');
const { sendUploadStatusEmail } = require('./services.emailService');
const logger = require('./utils.logger');

async function notifyUploadEvent(userId, { type, videoName, pageName }) {
  const titleMap = {
    success: 'Upload Successful',
    failure: 'Upload Failed',
    retry: 'Retrying Upload',
  };

  await Notification.create(userId, {
    type,
    title: titleMap[type] || 'Upload Update',
    message: `${videoName} → ${pageName}`,
  });

  try {
    const settings = await Settings.getOrCreate(userId);
    if (settings.email_alerts) {
      const user = await User.findById(userId);
      await sendUploadStatusEmail(user, { status: type, videoName, pageName });
    }
  } catch (err) {
    logger.error(`Notification email failed: ${err.message}`);
  }
}

module.exports = { notifyUploadEvent };
