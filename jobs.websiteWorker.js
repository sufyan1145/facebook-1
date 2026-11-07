/**
 * Website Automation worker:
 *  - runWebsiteArticle(): write article (Gemini) -> pictures (Nano Banana) -> publish
 *  - a small in-process queue (one article at a time, so Vertex is never hammered)
 *  - the schedule checker (same matching strategy as jobs.textImageScheduleChecker.js:
 *    grace window + atomic per-slot claim, safe against double firing)
 *
 * enqueueWebsitePost() works in any process (web server for "Write now",
 * worker process for schedules).
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');
const execFileAsync = util.promisify(execFile);
const cron = require('node-cron');
const env = require('./config.env');
const logger = require('./utils.logger');
const Log = require('./models.Log');
const { WebsiteAccount, WebsiteSchedule, WebsitePost } = require('./models.Website');
const articleService = require('./services.websiteArticleService');
const publishService = require('./services.websitePublishService');
const vertexAiService = require('./services.vertexAiService');
const socialShare = require('./services.socialShareService');

const IMAGE_STYLE = 'Photorealistic, natural lighting, high quality editorial photo, 16:9 landscape, no text, no letters, no logos, no watermark.';

async function makeImage(prompt, baseName) {
  const dir = env.upload.tempDir;
  fs.mkdirSync(dir, { recursive: true });
  const raw = path.join(dir, `${baseName}.png`);
  const jpg = path.join(dir, `${baseName}.jpg`);
  try {
    await vertexAiService.generateImage(`${prompt}. ${IMAGE_STYLE}`, raw);
    // 1280 px wide JPEG: small enough for any blog host, sharp enough for articles
    await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-i', raw, '-vf', "scale='min(1280,iw)':-2", '-frames:v', '1', '-q:v', '4', jpg]);
    return jpg;
  } finally {
    try { fs.unlinkSync(raw); } catch (_) { /* ignore */ }
  }
}

async function runWebsiteArticle(post) {
  const tempFiles = [];
  try {
    const account = await WebsiteAccount.findById(post.user_id, post.account_id);
    if (!account) throw new Error('This website is no longer connected. Connect it again.');

    await WebsitePost.setStatus(post.id, 'writing');
    const avoidTitles = await WebsitePost.recentTitles(account.id, post.topic, 20);
    const article = await articleService.writeArticle({
      topic: post.topic, language: post.language, length: post.article_length,
      imageCount: post.image_count, avoidTitles,
    });
    logger.info(`[website] post ${post.id}: article written "${article.title}" (${article.words} words, ${article.images.length} picture(s) planned)`);

    // pictures: one at a time; a failed picture is skipped, never fails the article
    let urls = []; let featuredMediaId = null; let imageNote = null;
    if (article.images.length) {
      await WebsitePost.setStatus(post.id, 'images', { title: article.title });
      const made = [];
      let genFailed = 0;
      for (let i = 0; i < article.images.length; i++) {
        try {
          const file = await makeImage(article.images[i].imagePrompt, `web_${post.id}_${i}`);
          tempFiles.push(file);
          made.push({ index: i, path: file, fileName: `${post.id.slice(0, 8)}-${i + 1}.jpg`, alt: article.images[i].alt });
        } catch (err) {
          genFailed += 1;
          logger.warn(`[website] post ${post.id}: picture ${i + 1} not generated: ${err.message}`);
        }
      }
      if (made.length) {
        const up = await publishService.uploadImages(account, made);
        made.forEach((m, k) => { urls[m.index] = up.urls[k]; });
        featuredMediaId = up.featuredMediaId;
        imageNote = up.note;
      }
      const added = urls.filter(Boolean).length;
      if (added < article.images.length && !imageNote) imageNote = `${added}/${article.images.length} pictures added (${genFailed} could not be generated).`;
    }

    await WebsitePost.setStatus(post.id, 'publishing', { title: article.title });
    const html = articleService.renderHtml(article, urls);
    const result = await publishService.publishArticle(account, {
      title: article.title, html, excerpt: article.metaDescription, tags: article.tags,
      publishMode: post.publish_mode, featuredMediaId,
    });
    await WebsitePost.setStatus(post.id, post.publish_mode === 'draft' ? 'draft' : 'published', {
      title: article.title, url: result.url, excerpt: article.metaDescription, imageNote,
    });
    await Log.record(post.user_id, 'Website Article Published', { postId: post.id, title: article.title, url: result.url, platform: account.platform });

    // Optional: share the live article on Facebook pages / X. Never fails the article.
    if (post.publish_mode !== 'draft' && result.url && ((post.share_page_ids || []).length || (post.share_x_ids || []).length)) {
      try {
        const note = await socialShare.shareArticle({
          userId: post.user_id, title: article.title, excerpt: article.metaDescription, topic: post.topic, language: post.language,
          url: result.url, imagePath: tempFiles.find((f) => /\.jpg$/i.test(f)) || null,
          pageIds: post.share_page_ids, xIds: post.share_x_ids,
        });
        if (note) { await WebsitePost.setShareNote(post.id, note); await Log.record(post.user_id, 'Website Article Shared', { postId: post.id, note }); }
      } catch (err) {
        logger.warn(`[website] post ${post.id}: social share failed: ${err.message}`);
        await WebsitePost.setShareNote(post.id, `Share failed: ${String(err.message).slice(0, 200)}`);
      }
    }
    logger.info(`[website] post ${post.id}: ${post.publish_mode === 'draft' ? 'saved as draft' : 'published'} ${result.url}`);
  } catch (err) {
    logger.error(`[website] post ${post.id} failed: ${err.message}`);
    await WebsitePost.setStatus(post.id, 'failed', { error: String(err.message).slice(0, 500) });
    await Log.record(post.user_id, 'Website Article Failed', { postId: post.id, error: err.message }, 'error');
  } finally {
    tempFiles.forEach((f) => { try { fs.unlinkSync(f); } catch (_) { /* ignore */ } });
  }
}

// ---- in-process queue ------------------------------------------------------
const queue = [];
let draining = false;
function enqueueWebsitePost(post) {
  queue.push(post);
  drain();
}
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const post = queue.shift();
      try { await runWebsiteArticle(post); } catch (err) { logger.error(`[website] queued post ${post.id} threw: ${err.message}`); }
    }
  } finally {
    draining = false;
  }
}

// ---- schedule checker ------------------------------------------------------
const GRACE_MINUTES = env.upload.scheduleGraceMinutes;
const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function nowInTimezone(timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
  const parts = fmt.formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { hhmm: `${hour}:${get('minute')}`, weekday: get('weekday'), dateKey: `${get('year')}-${get('month')}-${get('day')}`, dayOfMonth: parseInt(get('day'), 10) };
}

function shouldRunToday(s, now) {
  if (s.repeat_type === 'daily') return true;
  if (s.repeat_type === 'weekly') return now.weekday === 'Mon';
  if (s.repeat_type === 'monthly') return now.dayOfMonth === 1;
  if (s.repeat_type === 'specific_days') return (s.specific_days || []).includes(WEEKDAY_MAP[now.weekday]);
  return false;
}

function withinGrace(target, hhmm) {
  const [th, tm] = target.split(':').map(Number);
  const [ch, cm] = hhmm.split(':').map(Number);
  const t = th * 60 + tm; const c = ch * 60 + cm;
  return c >= t && c <= t + GRACE_MINUTES;
}

function findDueSlot(s) {
  const now = nowInTimezone(s.timezone);
  if (s.repeat_type === 'multiple_times') {
    for (const t of Array.isArray(s.times) ? s.times : []) {
      if (withinGrace(t, now.hhmm) && (s.last_run_slots || {})[t] !== now.dateKey) return { slotKey: t, dateKey: now.dateKey };
    }
    return null;
  }
  if (!shouldRunToday(s, now) || !withinGrace(s.upload_time, now.hhmm)) return null;
  if ((s.last_run_slots || {})[s.repeat_type] === now.dateKey) return null;
  return { slotKey: s.repeat_type, dateKey: now.dateKey };
}

async function fireSchedule(s) {
  const post = await WebsitePost.create(s.user_id, {
    accountId: s.account_id, scheduleId: s.id, topic: s.topic, language: s.language,
    articleLength: s.article_length, imageCount: s.image_count, publishMode: s.publish_mode,
    sharePageIds: s.share_page_ids, shareXIds: s.share_x_ids,
  });
  await Log.record(s.user_id, 'Website Schedule Triggered', { scheduleId: s.id, postId: post.id, site: s.account_name });
  enqueueWebsitePost(post);
}

async function checkWebsiteSchedules() {
  const schedules = await WebsiteSchedule.listActiveWithAccount();
  for (const s of schedules) {
    try {
      let claimed = false;
      if (s.repeat_type === 'interval_hours') {
        claimed = await WebsiteSchedule.claimInterval(s.id, (s.interval_hours || 1) * 3600);
      } else {
        const due = findDueSlot(s);
        if (!due) continue;
        claimed = await WebsiteSchedule.claimSlot(s.id, due.slotKey, due.dateKey);
      }
      if (claimed) await fireSchedule(s);
    } catch (err) {
      logger.error(`[website] schedule check failed for ${s.id}: ${err.message}`);
      await Log.record(s.user_id, 'Website Schedule Check Error', { scheduleId: s.id, error: err.message }, 'error');
    }
  }
}

let isRunning = false;
function startWebsiteScheduleChecker() {
  cron.schedule(env.upload.scheduleCheckCron, () => {
    if (isRunning) return;
    isRunning = true;
    checkWebsiteSchedules()
      .catch((err) => logger.error(`checkWebsiteSchedules crashed: ${err.message}`))
      .finally(() => { isRunning = false; });
  });
  logger.info(`Website schedule checker started with cron: ${env.upload.scheduleCheckCron}`);
}

module.exports = { runWebsiteArticle, enqueueWebsitePost, startWebsiteScheduleChecker, checkWebsiteSchedules, findDueSlot };
