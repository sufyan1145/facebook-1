const crypto = require('crypto');
const { google } = require('googleapis');
const env = require('./config.env');
const logger = require('./utils.logger');
const Log = require('./models.Log');
const { WebsiteAccount, WebsiteSchedule, WebsitePost } = require('./models.Website');
const publishService = require('./services.websitePublishService');
const { enqueueWebsitePost } = require('./jobs.websiteWorker');
const articleService = require('./services.websiteArticleService');
const Page = require('./models.Page');
const XAccount = require('./models.XAccount');

const LANGUAGES = ['auto', 'english', 'urdu', 'hindi', 'arabic', 'spanish', 'french', 'german', 'portuguese', 'turkish', 'indonesian', 'bengali', 'russian', 'italian', 'dutch', 'chinese', 'japanese', 'korean'];
const LENGTHS = ['short', 'medium', 'long'];
const REPEATS = ['daily', 'weekly', 'monthly', 'specific_days', 'interval_hours', 'multiple_times'];
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

class BadRequest extends Error {}
const bad = (m) => { throw new BadRequest(m); };

// Article settings shared by "write now" and schedules.
function readArticleSettings(b) {
  const topic = String(b.topic || '').trim();
  if (topic.length < 3) bad('Describe what the article should be about (at least a few words).');
  if (topic.length > 4000) bad('The topic is too long (max 4000 characters).');
  const language = String(b.language || 'auto').toLowerCase();
  if (!LANGUAGES.includes(language)) bad('Unsupported language.');
  const articleLength = String(b.articleLength || 'medium');
  if (!LENGTHS.includes(articleLength)) bad('Article length must be short, medium or long.');
  const imageCount = b.imageCount === undefined || b.imageCount === '' ? 3 : parseInt(b.imageCount, 10);
  if (!Number.isInteger(imageCount) || imageCount < 0 || imageCount > articleService.MAX_IMAGES) bad(`Pictures must be between 0 and ${articleService.MAX_IMAGES}.`);
  const publishMode = b.publishMode === 'draft' ? 'draft' : 'publish';
  return { topic, language, articleLength, imageCount, publishMode };
}

function readScheduleSettings(b) {
  const repeat = String(b.repeat || '');
  if (!REPEATS.includes(repeat)) bad('Invalid repeat type.');
  const timezone = String(b.timezone || '').trim();
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch (_) { bad('Invalid timezone.'); }
  const times = (Array.isArray(b.times) ? b.times : []).filter(Boolean);
  if (times.some((t) => !HHMM.test(t)) || times.length > 24) bad('Each time must be HH:mm.');
  let uploadTime = String(b.uploadTime || '');
  if (repeat === 'multiple_times') {
    if (!times.length) bad('Add at least one time.');
    uploadTime = times[0];
  } else if (repeat !== 'interval_hours' && !HHMM.test(uploadTime)) bad('Time must be HH:mm.');
  if (repeat === 'interval_hours' && !HHMM.test(uploadTime)) uploadTime = '00:00';
  const intervalHours = parseInt(b.intervalHours, 10) || null;
  if (repeat === 'interval_hours' && !(intervalHours >= 1 && intervalHours <= 168)) bad('Hours must be between 1 and 168.');
  const specificDays = (Array.isArray(b.specificDays) ? b.specificDays : []).map(Number).filter((d) => d >= 0 && d <= 6);
  if (repeat === 'specific_days' && !specificDays.length) bad('Pick at least one day.');
  return { repeat, timezone, uploadTime, times, intervalHours, specificDays };
}

// Where to share the finished article. Only the user's own, still-connected targets are accepted.
async function readShareSettings(userId, b) {
  const ids = (v) => [...new Set((Array.isArray(v) ? v : []).map(String).filter((x) => /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 20);
  const sharePageIds = []; const shareXIds = [];
  for (const id of ids(b.sharePageIds)) {
    const p = await Page.findById(userId, id);
    if (!p || !p.is_connected) bad('One of the selected Facebook pages is not connected.');
    sharePageIds.push(id);
  }
  for (const id of ids(b.shareXIds)) {
    const x = await XAccount.findById(userId, id);
    if (!x) bad('One of the selected X accounts is not connected.');
    shareXIds.push(id);
  }
  return { sharePageIds, shareXIds };
}

async function ownAccount(userId, accountId) {
  const id = String(accountId || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) bad('Choose a website first.');
  const acc = await WebsiteAccount.findById(userId, id);
  if (!acc) bad('That website is not connected.');
  return acc;
}

const wrap = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json({ success: false, message: err.message });
    next(err);
  }
};

// ---- accounts ---------------------------------------------------------------
const listAccounts = wrap(async (req, res) => {
  res.json({ success: true, data: await WebsiteAccount.listByUser(req.user.id) });
});

const testWordPress = wrap(async (req, res) => {
  try {
    const r = await publishService.testWordPress(req.body || {});
    res.json({ success: true, data: r });
  } catch (err) { bad(err.message); }
});

const addWordPress = wrap(async (req, res) => {
  const b = req.body || {};
  let info;
  try { info = await publishService.testWordPress(b); } catch (err) { bad(err.message); }
  const name = String(b.name || '').trim() || new URL(info.siteUrl).host;
  const acc = await WebsiteAccount.createWordPress(req.user.id, {
    name: name.slice(0, 120), siteUrl: info.siteUrl, username: String(b.username).trim(), appPassword: String(b.appPassword).trim(),
  });
  await Log.record(req.user.id, 'Website Connected', { platform: 'wordpress', site: info.siteUrl });
  res.status(201).json({ success: true, data: acc });
});

const removeAccount = wrap(async (req, res) => {
  await WebsiteAccount.remove(req.user.id, req.params.id);
  await Log.record(req.user.id, 'Website Disconnected', { accountId: req.params.id });
  res.json({ success: true });
});

// ---- Blogger OAuth ------------------------------------------------------------
// The state carries the user id, signed so nobody can attach a blog to someone else's account.
function signState(userId) {
  const ts = Date.now().toString(36);
  const sig = crypto.createHmac('sha256', String(env.cookieSecret || 'x')).update(`${userId}.${ts}`).digest('hex').slice(0, 32);
  return `${userId}.${ts}.${sig}`;
}
function readState(state) {
  const [userId, ts, sig] = String(state || '').split('.');
  if (!userId || !ts || !sig) return null;
  const want = crypto.createHmac('sha256', String(env.cookieSecret || 'x')).update(`${userId}.${ts}`).digest('hex').slice(0, 32);
  const okSig = sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  if (!okSig || Date.now() - parseInt(ts, 36) > 15 * 60 * 1000) return null;
  return userId;
}

const bloggerConnect = wrap(async (req, res) => {
  const client = publishService.getBloggerOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent select_account', scope: publishService.BLOGGER_SCOPES, state: signState(req.user.id),
  });
  res.json({ success: true, data: { url } });
});

async function bloggerCallback(req, res) {
  const back = (q) => res.redirect(`${env.frontendUrl}/website.html?${q}`);
  try {
    if (req.query.error) return back(`blogger_error=${encodeURIComponent(String(req.query.error))}`);
    const userId = readState(req.query.state);
    if (!userId) return back('blogger_error=' + encodeURIComponent('The connect link expired. Please try again.'));
    const client = publishService.getBloggerOAuthClient();
    const { tokens } = await client.getToken(String(req.query.code || ''));
    client.setCredentials(tokens);
    let email = null;
    try { email = (await google.oauth2({ version: 'v2', auth: client }).userinfo.get()).data.email; } catch (_) { /* optional */ }
    const blogger = google.blogger({ version: 'v3', auth: client });
    const { data } = await blogger.blogs.listByUser({ userId: 'self' });
    const blogs = data.items || [];
    if (!blogs.length) return back('blogger_error=' + encodeURIComponent('No Blogger blog was found on that Google account. Create a blog on blogger.com first.'));
    for (const blog of blogs) {
      await WebsiteAccount.upsertBlogger(userId, {
        name: blog.name, siteUrl: blog.url, blogId: String(blog.id), email,
        accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
        expiryTime: tokens.expiry_date ? new Date(tokens.expiry_date) : null, scope: tokens.scope,
      });
    }
    await Log.record(userId, 'Website Connected', { platform: 'blogger', blogs: blogs.length });
    return back(`blogger_connected=${blogs.length}`);
  } catch (err) {
    logger.error(`[website] Blogger callback failed: ${err.message}`);
    return back('blogger_error=' + encodeURIComponent(publishService.bloggerErrorMessage(err)));
  }
}

// ---- schedules ----------------------------------------------------------------
const listSchedules = wrap(async (req, res) => {
  res.json({ success: true, data: await WebsiteSchedule.listByUser(req.user.id) });
});

const createSchedule = wrap(async (req, res) => {
  const acc = await ownAccount(req.user.id, req.body.accountId);
  const data = { accountId: acc.id, ...readArticleSettings(req.body), ...readScheduleSettings(req.body), ...(await readShareSettings(req.user.id, req.body)) };
  const s = await WebsiteSchedule.create(req.user.id, data);
  await Log.record(req.user.id, 'Website Schedule Created', { scheduleId: s.id });
  res.status(201).json({ success: true, data: s });
});

const updateSchedule = wrap(async (req, res) => {
  const acc = await ownAccount(req.user.id, req.body.accountId);
  const data = { accountId: acc.id, ...readArticleSettings(req.body), ...readScheduleSettings(req.body), ...(await readShareSettings(req.user.id, req.body)) };
  const s = await WebsiteSchedule.update(req.user.id, req.params.id, data);
  if (!s) return res.status(404).json({ success: false, message: 'Schedule not found' });
  res.json({ success: true, data: s });
});

const toggleSchedule = wrap(async (req, res) => {
  const s = await WebsiteSchedule.setActive(req.user.id, req.params.id, !!req.body.isActive);
  if (!s) return res.status(404).json({ success: false, message: 'Schedule not found' });
  res.json({ success: true, data: s });
});

const deleteSchedule = wrap(async (req, res) => {
  await WebsiteSchedule.remove(req.user.id, req.params.id);
  res.json({ success: true });
});

// ---- articles ------------------------------------------------------------------
const writeNow = wrap(async (req, res) => {
  const acc = await ownAccount(req.user.id, req.body.accountId);
  const s = readArticleSettings(req.body);
  const share = await readShareSettings(req.user.id, req.body);
  const post = await WebsitePost.create(req.user.id, { accountId: acc.id, ...s, ...share });
  await Log.record(req.user.id, 'Website Article Started', { postId: post.id, site: acc.name });
  enqueueWebsitePost(post);
  res.status(202).json({ success: true, data: post });
});

const retryPost = wrap(async (req, res) => {
  const old = await WebsitePost.findById(req.user.id, req.params.id);
  if (!old) return res.status(404).json({ success: false, message: 'Not found' });
  if (old.status !== 'failed') bad('Only failed articles can be retried.');
  const acc = await ownAccount(req.user.id, old.account_id);
  const post = await WebsitePost.create(req.user.id, {
    accountId: acc.id, topic: old.topic, language: old.language, articleLength: old.article_length,
    imageCount: old.image_count, publishMode: old.publish_mode,
    sharePageIds: old.share_page_ids, shareXIds: old.share_x_ids,
  });
  enqueueWebsitePost(post);
  res.status(202).json({ success: true, data: post });
});

// Share an already published article (again) - gives instant feedback with the real error.
const sharePost = wrap(async (req, res) => {
  const post = await WebsitePost.findById(req.user.id, req.params.id);
  if (!post) return res.status(404).json({ success: false, message: 'Not found' });
  if (post.status !== 'published' || !post.url) bad('Only published articles can be shared.');
  const share = await readShareSettings(req.user.id, req.body || {});
  if (!share.sharePageIds.length && !share.shareXIds.length) bad('Tick at least one Facebook page or X account in the "Share" list first.');
  const note = await require('./services.socialShareService').shareArticle({
    userId: req.user.id, title: post.title || post.topic, excerpt: post.excerpt, topic: post.topic, language: post.language,
    url: post.url, imagePath: null, pageIds: share.sharePageIds, xIds: share.shareXIds,
  });
  await WebsitePost.setShareNote(post.id, note || 'Nothing was shared.');
  res.json({ success: true, data: { note } });
});

const listPosts = wrap(async (req, res) => {
  res.json({ success: true, data: await WebsitePost.listByUser(req.user.id, 60) });
});

const deletePost = wrap(async (req, res) => {
  await WebsitePost.remove(req.user.id, req.params.id);
  res.json({ success: true });
});

module.exports = {
  listAccounts, testWordPress, addWordPress, removeAccount, bloggerConnect, bloggerCallback,
  listSchedules, createSchedule, updateSchedule, toggleSchedule, deleteSchedule,
  writeNow, retryPost, sharePost, listPosts, deletePost,
};
