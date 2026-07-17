const UploadHistory = require('./models.UploadHistory');
const Page = require('./models.Page');
const DriveFolder = require('./models.DriveFolder');
const Schedule = require('./models.Schedule');
const { getQueueStatus } = require('./queue.queues');
const Log = require('./models.Log');

async function overview(req, res, next) {
  try {
    const userId = req.user.id;
    const [stats, pages, folders, schedules, queueCounts, recentActivity] = await Promise.all([
      UploadHistory.statsByUser(userId),
      Page.listByUser(userId),
      DriveFolder.listByUser(userId),
      Schedule.listByUser(userId),
      getQueueStatus(),
      Log.listByUser(userId, { limit: 20 }),
    ]);

    res.json({
      success: true,
      data: {
        connectedDrives: folders.length > 0 ? 1 : 0,
        connectedPages: pages.filter((p) => p.is_connected).length,
        activeSchedules: schedules.filter((s) => s.is_active).length,
        todaysUploads: Number(stats.today_uploads || 0),
        failedUploads: Number(stats.failed_uploads || 0),
        totalUploads: Number(stats.total_uploads || 0),
        queue: queueCounts,
        recentActivity,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { overview };
