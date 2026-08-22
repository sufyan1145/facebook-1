/**
 * Checks Text + Image Post schedules every minute and queues a post when one is due.
 *
 * Deliberately a standalone copy of jobs.scheduleChecker.js's matching strategy
 * (grace-window catch-up + atomic per-slot claiming via last_run_slots) rather than
 * a shared import, so the already-working video schedule checker can never be
 * affected by anything here.
 *
 * For 'drive' sourced schedules, each run auto-picks a Drive image that has never
 * been posted (or is not currently queued/processing) for that specific Page, so
 * scheduled runs never repeat an image on the same Page. If every image in the
 * folder has already been used, that run is skipped (logged) rather than reposting.
 * For 'ai' sourced schedules, a brand new image is generated every run, so repeats
 * are a non-issue there.
 */
const cron = require('node-cron');
const { query } = require('./config.database');
const { addTextImagePostJob } = require('./queue.queues');
const driveService = require('./services.googleDriveService');
const captionGenService = require('./services.captionGenService');
const TextImageSchedule = require('./models.TextImageSchedule');
const TextImagePost = require('./models.TextImagePost');
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
  if (schedule.repeat_type === 'weekly') return weekday === 'Mon';
  if (schedule.repeat_type === 'monthly') return new Date().getDate() === 1;
  if (schedule.repeat_type === 'specific_days') {
    return (schedule.specific_days || []).includes(WEEKDAY_MAP[weekday]);
  }
  return false;
}

function withinGraceWindow(targetHHMM, hhmm) {
  const [targetH, targetM] = targetHHMM.split(':').map(Number);
  const [curH, curM] = hhmm.split(':').map(Number);
  const targetMinutes = targetH * 60 + targetM;
  const curMinutes = curH * 60 + curM;
  return curMinutes >= targetMinutes && curMinutes <= targetMinutes + GRACE_MINUTES;
}

function findDueSlot(schedule) {
  if (schedule.repeat_type === 'multiple_times') {
    const { hhmm, dateKey } = nowInTimezone(schedule.timezone);
    const times = Array.isArray(schedule.times) ? schedule.times : [];
    for (const t of times) {
      if (withinGraceWindow(t, hhmm)) {
        const lastForThisTime = schedule.last_run_slots ? schedule.last_run_slots[t] : null;
        if (lastForThisTime !== dateKey) return { slotKey: t, dateKey };
      }
    }
    return null;
  }

  const { hhmm, weekday, dateKey } = nowInTimezone(schedule.timezone);
  if (!shouldRunToday(schedule, weekday)) return null;
  if (!withinGraceWindow(schedule.upload_time, hhmm)) return null;

  const slotKey = schedule.repeat_type;
  const lastForThisSlot = schedule.last_run_slots ? schedule.last_run_slots[slotKey] : null;
  if (lastForThisSlot === dateKey) return null;
  return { slotKey, dateKey };
}

async function fireSchedule(schedule) {
  let driveFileId = null;
  let driveFileName = null;

  if (schedule.image_source === 'drive') {
    if (!schedule.drive_folder_id) {
      logger.warn(`Text-image schedule ${schedule.id} has no Drive folder configured - skipping this run`);
      await Log.record(schedule.user_id, 'Text+Image Schedule Skipped', { scheduleId: schedule.id, reason: 'No Drive folder configured' }, 'error');
      return;
    }
    const images = await driveService.listImagesInFolder(schedule.user_id, schedule.drive_folder_id);
    const reservedIds = await TextImagePost.getReservedFileIds(schedule.page_id);
    const reservedSet = new Set(reservedIds);
    const fresh = images.find((img) => !reservedSet.has(img.id));

    if (!fresh) {
      logger.info(`Text-image schedule ${schedule.id}: no unused images left in folder "${schedule.folder_name}" for this Page - skipping this run`);
      await Log.record(schedule.user_id, 'Text+Image Schedule Skipped', {
        scheduleId: schedule.id,
        reason: 'All images in this folder have already been posted to this Page',
      });
      return;
    }
    driveFileId = fresh.id;
    driveFileName = fresh.name;
  }

  let message = schedule.message;
  let aiPrompt = schedule.ai_prompt;

  if (schedule.image_source === 'ai' && schedule.topic) {
    // Topic mode: generate a brand new, matching caption + image prompt every
    // run (in whatever language the topic itself is written in) - and tell the
    // AI what's already been posted recently on this schedule so it picks a
    // genuinely different person/quote/angle instead of repeating.
    const recentMessages = await TextImagePost.getRecentMessagesForSchedule(schedule.id, 15);
    const content = await captionGenService.generatePostContent(schedule.topic, recentMessages);
    message = content.caption;
    aiPrompt = content.imagePrompt;

    if (content.fallbackReason) {
      await Log.record(schedule.user_id, 'Text+Image AI Content Fallback', {
        scheduleId: schedule.id,
        reason: content.fallbackReason,
        note: 'Structured caption/image-prompt generation failed - the raw topic text was posted as-is instead.',
      }, 'error');
    }
  }

  const post = await TextImagePost.create(schedule.user_id, {
    pageId: schedule.page_id,
    message,
    imageSource: schedule.image_source,
    driveFileId,
    driveFileName,
    aiPrompt,
    scheduleId: schedule.id,
  });

  await addTextImagePostJob({
    userId: schedule.user_id,
    postId: post.id,
    pageId: schedule.page_id,
    pageDbId: schedule.page_id,
    message,
    imageSource: schedule.image_source,
    driveFileId,
    driveFileName,
    aiPrompt,
  });

  await Log.record(schedule.user_id, 'Text+Image Schedule Triggered', {
    scheduleId: schedule.id,
    postId: post.id,
    page: schedule.page_name,
    source: schedule.image_source,
  });
}

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

async function checkTextImageSchedules() {
  const res = await query(
    `SELECT s.*, p.page_name, p.is_connected as page_is_connected,
            df.folder_id as drive_folder_id, df.folder_name
     FROM text_image_schedules s
     JOIN pages p ON p.id = s.page_id
     LEFT JOIN drive_folders df ON df.id = s.folder_id
     WHERE s.is_active = TRUE AND p.is_connected = TRUE`
  );

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
        claimed = await TextImageSchedule.claimInterval(schedule.id, intervalSeconds);
      } else {
        claimed = await TextImageSchedule.claimSlot(schedule.id, slotKey, dateKey);
      }
      if (!claimed) return;

      await fireSchedule(schedule);
    } catch (err) {
      logger.error(`Text-image schedule check failed for ${schedule.id}: ${err.message}`);
      await Log.record(schedule.user_id, 'Text+Image Schedule Check Error', { scheduleId: schedule.id, error: err.message }, 'error');
    }
  });
}

let isRunning = false;

function startTextImageScheduleChecker() {
  cron.schedule(env.upload.scheduleCheckCron, () => {
    if (isRunning) {
      logger.warn('Text-image schedule checker tick skipped - previous tick still running');
      return;
    }
    isRunning = true;
    checkTextImageSchedules()
      .catch((err) => logger.error(`checkTextImageSchedules crashed: ${err.message}`))
      .finally(() => {
        isRunning = false;
      });
  });
  logger.info(`Text-image schedule checker started with cron: ${env.upload.scheduleCheckCron}`);
}

module.exports = { startTextImageScheduleChecker, checkTextImageSchedules };
