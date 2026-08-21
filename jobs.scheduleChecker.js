/**
 * Worker 1: Schedule Checker
 * Runs every minute (via node-cron). For each active schedule whose configured time(s)
 * match the current time in the schedule's timezone (and repeat rule), enqueue upload jobs.
 *
 * Robustness guarantees (so no schedule is ever silently missed, no matter how many exist):
 *  - A GRACE_MINUTES catch-up window applies to every repeat type, not just daily,
 *    so a slow tick, a deploy, or a brief outage still gets caught on the next tick(s).
 *  - Each specific time-of-day is claimed atomically in the database (last_run_slots) before
 *    it's processed, so the same slot can never fire twice (across overlapping ticks or
 *    multiple worker replicas) and a slot that's already fired today is never re-fired.
 *  - A re-entrancy guard skips starting a new tick while a previous one is still running,
 *    so a long-running tick (e.g. many schedules) can't overlap itself.
 *  - Due schedules are processed with a concurrency limit instead of one at a time, so a
 *    large batch due at the same minute finishes well within the tick interval instead of
 *    queuing up behind slow per-schedule Drive API calls.
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

const GRACE_MINUTES = env.upload.scheduleGraceMinutes;
const CHECK_CONCURRENCY = env.upload.scheduleCheckConcurrency;

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
  // Some ICU builds render midnight as "24:00" instead of "00:00" with hour12:false -
  // normalize that so exact/window matching against "00:xx" configured times still works.
  const hour = get('hour') === '24' ? '00' : get('hour');
  return {
    hhmm: `${hour}:${get('minute')}`,
    weekday: get('weekday'),
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
  };
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

// Is `hhmm` within [targetHHMM, targetHHMM + GRACE_MINUTES]? (same-day minutes-of-day math)
function withinGraceWindow(targetHHMM, hhmm) {
  const [targetH, targetM] = targetHHMM.split(':').map(Number);
  const [curH, curM] = hhmm.split(':').map(Number);
  const targetMinutes = targetH * 60 + targetM;
  const curMinutes = curH * 60 + curM;
  return curMinutes >= targetMinutes && curMinutes <= targetMinutes + GRACE_MINUTES;
}

/**
 * Figures out, for one schedule row, which slot (if any) is due right now.
 * Returns null if nothing is due, otherwise { slotKey, dateKey } identifying
 * the exact slot to atomically claim.
 */
function findDueSlot(schedule) {
  if (schedule.repeat_type === 'multiple_times') {
    const { hhmm, dateKey } = nowInTimezone(schedule.timezone);
    const times = Array.isArray(schedule.times) ? schedule.times : [];
    for (const t of times) {
      if (withinGraceWindow(t, hhmm)) {
        const lastForThisTime = schedule.last_run_slots ? schedule.last_run_slots[t] : null;
        if (lastForThisTime !== dateKey) {
          return { slotKey: t, dateKey };
        }
      }
    }
    return null;
  }

  // daily / weekly / monthly / specific_days
  const { hhmm, weekday, dateKey } = nowInTimezone(schedule.timezone);
  if (!shouldRunToday(schedule, weekday)) return null;
  if (!withinGraceWindow(schedule.upload_time, hhmm)) return null;

  const slotKey = schedule.repeat_type;
  const lastForThisSlot = schedule.last_run_slots ? schedule.last_run_slots[slotKey] : null;
  if (lastForThisSlot === dateKey) return null;
  return { slotKey, dateKey };
}

async function fireSchedule(schedule) {
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

  await Log.record(schedule.user_id, 'Schedule Triggered', {
    scheduleId: schedule.id,
    videosQueued: toUpload.length,
  });
}

// Runs `worker` over `items` with at most `limit` in flight at once.
async function processWithConcurrency(items, limit, worker) {
  let idx = 0;
  async function runner() {
    while (idx < items.length) {
      const current = items[idx++];
      await worker(current);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, runner));
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

  // Cheap in-memory pass first: figure out which schedules have a due slot right now.
  // No I/O happens here, so this stays fast even with thousands of schedule rows.
  const candidates = [];
  for (const schedule of res.rows) {
    if (schedule.repeat_type === 'interval_hours') {
      candidates.push({ schedule, kind: 'interval' });
      continue;
    }
    const due = findDueSlot(schedule);
    if (due) candidates.push({ schedule, kind: 'slot', ...due });
  }

  if (!candidates.length) return;

  await processWithConcurrency(candidates, CHECK_CONCURRENCY, async ({ schedule, kind, slotKey, dateKey }) => {
    try {
      let claimed = false;
      if (kind === 'interval') {
        const intervalSeconds = (schedule.interval_hours || 1) * 3600;
        claimed = await Schedule.claimInterval(schedule.id, intervalSeconds);
      } else {
        claimed = await Schedule.claimSlot(schedule.id, slotKey, dateKey);
      }

      // Someone else (an earlier tick, or another worker replica) already claimed this
      // exact slot - skip so we never fire it twice.
      if (!claimed) return;

      await fireSchedule(schedule);
    } catch (err) {
      logger.error(`Schedule check failed for schedule ${schedule.id}: ${err.message}`);
      await Log.record(schedule.user_id, 'Schedule Check Error', { scheduleId: schedule.id, error: err.message }, 'error');
    }
  });
}

let isRunning = false;

function startScheduleChecker() {
  cron.schedule(env.upload.scheduleCheckCron, () => {
    if (isRunning) {
      logger.warn('Schedule checker tick skipped - previous tick still running');
      return;
    }
    isRunning = true;
    checkSchedules()
      .catch((err) => logger.error(`checkSchedules crashed: ${err.message}`))
      .finally(() => {
        isRunning = false;
      });
  });
  logger.info(
    `Schedule checker started with cron: ${env.upload.scheduleCheckCron} (grace: ${GRACE_MINUTES}m, concurrency: ${CHECK_CONCURRENCY})`
  );
}

module.exports = { startScheduleChecker, checkSchedules };
