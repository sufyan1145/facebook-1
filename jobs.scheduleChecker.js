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
const UploadHistory = require('./models.UploadHistory');
const Log = require('./models.Log');
const logger = require('./utils.logger');
const env = require('./config.env');

function nowInTimezone(timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  });
  const parts = fmt.formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    hhmm: `${get('hour')}:${get('minute')}`,
    weekday: get('weekday'),
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

function dateKeyInTimezone(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
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
    `SELECT s.*, p.id as page_db_id, p.page_id as fb_page_id, p.page_name, p.page_access_token, p.is_connected as page_is_connected,
            df.folder_id as drive_folder_id, df.folder_name
     FROM schedules s
     LEFT JOIN pages p ON p.id = s.page_id
     JOIN drive_folders df ON df.id = s.folder_id
     WHERE s.is_active = TRUE AND (s.page_id IS NULL OR p.is_connected = TRUE)`
  );

  for (const schedule of res.rows) {
    try {
      let isDue = false;

      if (schedule.repeat_type === 'interval_hours') {
        const intervalMs = (schedule.interval_hours || 1) * 60 * 60 * 1000;
        if (!schedule.last_run_at) {
          isDue = true; // first run happens immediately once the schedule is active
        } else {
          const elapsedMs = Date.now() - new Date(schedule.last_run_at).getTime();
          isDue = elapsedMs >= intervalMs;
        }
      } else if (schedule.repeat_type === 'multiple_times') {
        const { hhmm } = nowInTimezone(schedule.timezone);
        const times = Array.isArray(schedule.times) ? schedule.times : [];
        if (times.includes(hhmm)) {
          if (schedule.last_run_at) {
            const diffMs = Date.now() - new Date(schedule.last_run_at).getTime();
            isDue = diffMs >= 55000; // avoid double-run within same minute
          } else {
            isDue = true;
          }
        }
      } else {
        const { hhmm, weekday, dateKey } = nowInTimezone(schedule.timezone);
        if (shouldRunToday(schedule, weekday)) {
          const [targetH, targetM] = schedule.upload_time.split(':').map(Number);
          const [curH, curM] = hhmm.split(':').map(Number);
          const targetMinutes = targetH * 60 + targetM;
          const curMinutes = curH * 60 + curM;
          const GRACE_MINUTES = 15; // catch up if the exact minute was missed (e.g. deploy/restart)

          const withinWindow = curMinutes >= targetMinutes && curMinutes <= targetMinutes + GRACE_MINUTES;
          if (withinWindow) {
            const lastRunDateKey = schedule.last_run_at
              ? dateKeyInTimezone(new Date(schedule.last_run_at), schedule.timezone)
              : null;
            isDue = lastRunDateKey !== dateKey; // hasn't already run today
          }
        }
      }

      if (!isDue) continue;

      const uploadedIds = await UploadHistory.getUploadedFileIds(schedule.page_id);
      const videos = await driveService.listUnpublishedVideos(schedule.user_id, schedule.drive_folder_id, uploadedIds);
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
            postToFacebook: schedule.post_to_facebook,
            youtubeTokenId: schedule.youtube_token_id,
            youtubeVideoType: schedule.youtube_video_type,
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
