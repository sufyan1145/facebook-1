/**
 * Worker 1: Schedule Checker
 * Runs every minute (via node-cron). For each active schedule whose upload_time matches
 * the current time in the schedule's timezone (and repeat rule), enqueue upload jobs.
 */
const cron = require('node-cron');
const { query } = require('./config.database');
const { addUploadJob } = require('./queue.queues');
const driveService = require('./services.googleDriveService');
const Schedule = require('./models.Schedule');
const Log = require('./models.Log');
const logger = require('./utils.logger');
const env = require('./config.env');

function nowInTimezone(timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(new Date());
  const hh = parts.find((p) => p.type === 'hour').value;
  const mm = parts.find((p) => p.type === 'minute').value;
  const weekday = parts.find((p) => p.type === 'weekday').value;
  return { hhmm: `${hh}:${mm}`, weekday };
}

const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function shouldRunToday(schedule, weekday) {
  if (schedule.repeat_type === 'daily') return true;
  if (schedule.repeat_type === 'weekly') return weekday === 'Mon'; // simple weekly anchor
  if (schedule.repeat_type === 'monthly') return new Date().getDate() === 1;
  if (schedule.repeat_type === 'specific_days') {
    return (schedule.specific_days || []).includes(WEEKDAY_MAP[weekday]);
  }
  return false;
}

async function checkSchedules() {
  const res = await query(
    `SELECT s.*, p.id as page_db_id, p.page_id as fb_page_id, p.page_name, df.folder_id as drive_folder_id, df.folder_name
     FROM schedules s
     JOIN pages p ON p.id = s.page_id
     JOIN drive_folders df ON df.id = s.folder_id
     WHERE s.is_active = TRUE AND p.is_connected = TRUE`
  );

  for (const schedule of res.rows) {
    try {
      const { hhmm, weekday } = nowInTimezone(schedule.timezone);
      if (hhmm !== schedule.upload_time) continue;
      if (!shouldRunToday(schedule, weekday)) continue;

      // Avoid double-run within same minute
      if (schedule.last_run_at) {
        const last = new Date(schedule.last_run_at);
        const diffMs = Date.now() - last.getTime();
        if (diffMs < 55000) continue;
      }

      const videos = await driveService.listUnpublishedVideos(schedule.user_id, schedule.drive_folder_id, []);
      const toUpload = videos.slice(0, schedule.max_uploads || 1);

      for (const file of toUpload) {
        file.folderName = schedule.folder_name;
        const delay = schedule.random_delay_seconds
          ? Math.floor(Math.random() * schedule.random_delay_seconds) * 1000
          : 0;

        await addUploadJob(
          {
            userId: schedule.user_id,
            scheduleId: schedule.id,
            pageDbId: schedule.page_id,
            folderGoogleId: schedule.drive_folder_id,
            file,
            caption: schedule.caption,
            hashtags: schedule.hashtags,
            privacy: schedule.privacy,
            publishImmediately: schedule.publish_immediately,
            pageName: schedule.page_name,
          },
          { delay }
        );
      }

      await Schedule.updateLastRun(schedule.id);
      await Log.record(schedule.user_id, 'Schedule Triggered', {
        scheduleId: schedule.id,
        videosQueued: toUpload.length,
      });
    } catch (err) {
      logger.error(`Schedule check failed for schedule ${schedule.id}: ${err.message}`);
      await Log.record(schedule.user_id, 'Schedule Check Error', { scheduleId: schedule.id, error: err.message }, 'error');
    }
  }
}

function startScheduleChecker() {
  cron.schedule(env.upload.scheduleCheckCron, () => {
    checkSchedules().catch((err) => logger.error(`checkSchedules crashed: ${err.message}`));
  });
  logger.info(`Schedule checker started with cron: ${env.upload.scheduleCheckCron}`);
}

module.exports = { startScheduleChecker, checkSchedules };
