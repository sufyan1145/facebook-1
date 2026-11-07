/**
 * Publishing to WordPress (REST API + Application Password) and Blogger
 * (Blogger API v3, Google OAuth).
 *
 * Images:
 *  - WordPress: uploaded to the site's own Media Library (and the first one is
 *    set as the featured image).
 *  - Blogger has no image-upload API, so pictures go to the user's Google Drive
 *    as "anyone with the link" files and are linked from the post. If that is
 *    not possible (Drive full / not connected) the article is still published,
 *    just without pictures, and the reason is returned.
 */
const axios = require('axios');
const fs = require('fs');
const { google } = require('googleapis');
const env = require('./config.env');
const logger = require('./utils.logger');
const { WebsiteAccount } = require('./models.Website');

const BLOGGER_SCOPES = [
  'https://www.googleapis.com/auth/blogger',
  'https://www.googleapis.com/auth/userinfo.email',
];

// ---- WordPress -------------------------------------------------------------
function normalizeSiteUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) throw new Error('Website address is required');
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const parsed = new URL(u);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
}

function wpHttp(account, extra = {}) {
  return axios.create({
    baseURL: `${account.site_url}/wp-json/wp/v2`,
    auth: { username: account.wp_username, password: account.wp_app_password },
    timeout: 60000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    ...extra,
  });
}

function wpErrorMessage(err) {
  const status = err.response && err.response.status;
  const data = err.response && err.response.data;
  if (status === 401 || status === 403) return 'WordPress refused the login. Check the username and the Application Password (not your normal password), and that the user can publish posts.';
  if (status === 404) return 'WordPress REST API was not found at this address. Check the website URL (and that permalinks / REST API are not disabled).';
  if (data && data.message) return `WordPress: ${String(data.message).replace(/<[^>]+>/g, '')}`;
  return err.message;
}

async function testWordPress({ siteUrl, username, appPassword }) {
  const account = { site_url: normalizeSiteUrl(siteUrl), wp_username: String(username || '').trim(), wp_app_password: String(appPassword || '').trim() };
  if (!account.wp_username || !account.wp_app_password) throw new Error('Username and Application Password are required');
  try {
    const { data } = await wpHttp(account).get('/users/me', { params: { context: 'edit' } });
    const can = data && data.capabilities;
    if (can && !can.publish_posts && !can.edit_posts) throw new Error('This WordPress user cannot create posts. Use an Editor or Administrator user.');
    return { siteUrl: account.site_url, userName: data && data.name };
  } catch (err) {
    if (err.response) throw new Error(wpErrorMessage(err));
    throw err;
  }
}

async function wpUploadImage(account, filePath, fileName, alt) {
  try {
    const { data } = await wpHttp(account).post('/media', fs.readFileSync(filePath), {
      headers: { 'Content-Type': 'image/jpeg', 'Content-Disposition': `attachment; filename="${fileName}"` },
      timeout: 120000,
    });
    if (alt) { try { await wpHttp(account).post(`/media/${data.id}`, { alt_text: alt }); } catch (_) { /* cosmetic */ } }
    return { id: data.id, url: data.source_url };
  } catch (err) {
    throw new Error(err.response ? wpErrorMessage(err) : err.message);
  }
}

async function wpTagIds(account, tags) {
  const ids = [];
  for (const name of (tags || []).slice(0, 8)) {
    try {
      const { data } = await wpHttp(account).post('/tags', { name });
      ids.push(data.id);
    } catch (err) {
      const existing = err.response && err.response.data && err.response.data.data && err.response.data.data.term_id;
      if (existing) ids.push(existing);
    }
  }
  return ids;
}

async function wpCreatePost(account, { title, html, excerpt, tags, publishMode, featuredMediaId }) {
  try {
    const body = { title, content: html, excerpt: excerpt || '', status: publishMode === 'draft' ? 'draft' : 'publish' };
    const tagIds = await wpTagIds(account, tags);
    if (tagIds.length) body.tags = tagIds;
    if (featuredMediaId) body.featured_media = featuredMediaId;
    const { data } = await wpHttp(account).post('/posts', body);
    return { url: data.link, id: String(data.id) };
  } catch (err) {
    throw new Error(err.response ? wpErrorMessage(err) : err.message);
  }
}

// ---- Blogger ---------------------------------------------------------------
function getBloggerOAuthClient() {
  return new google.auth.OAuth2(env.google.clientId, env.google.clientSecret, `${env.appUrl}/api/auth/blogger/callback`);
}

async function getBloggerAuth(account) {
  const client = getBloggerOAuthClient();
  client.setCredentials({
    access_token: account.access_token,
    refresh_token: account.refresh_token,
    expiry_date: account.expiry_time ? new Date(account.expiry_time).getTime() : undefined,
  });
  const expired = !account.expiry_time || new Date(account.expiry_time).getTime() - Date.now() < 60000;
  if (expired && account.refresh_token) {
    const { credentials } = await client.refreshAccessToken();
    client.setCredentials(credentials);
    await WebsiteAccount.updateTokens(account.id, {
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token || null,
      expiryTime: credentials.expiry_date ? new Date(credentials.expiry_date) : null,
      scope: credentials.scope,
    });
    logger.info(`[website] refreshed Blogger token for account ${account.id}`);
  }
  return client;
}

function bloggerErrorMessage(err) {
  const msg = err && err.response && err.response.data && err.response.data.error && err.response.data.error.message;
  if (/has not been used|disabled/i.test(msg || '')) return 'Blogger API is not enabled in your Google Cloud project (APIs & Services > Library > "Blogger API v3" > Enable).';
  if (err && (err.code === 401 || /invalid_grant/i.test(err.message || ''))) return 'Blogger login expired. Remove this blog and connect it again.';
  return msg || err.message;
}

async function bloggerPublish(account, { title, html, tags, publishMode }) {
  try {
    const auth = await getBloggerAuth(account);
    const blogger = google.blogger({ version: 'v3', auth });
    const { data } = await blogger.posts.insert({
      blogId: account.blog_id,
      isDraft: publishMode === 'draft',
      requestBody: { title, content: html, labels: (tags || []).slice(0, 8) },
    });
    return { url: data.url, id: String(data.id) };
  } catch (err) {
    throw new Error(bloggerErrorMessage(err));
  }
}

// Public Drive file -> URL usable inside the Blogger post.
async function driveHostedImage(userId, filePath, fileName) {
  const { getValidGoogleClient } = require('./services.tokenService');
  const auth = await getValidGoogleClient(userId);
  const drive = google.drive({ version: 'v3', auth });
  const created = await drive.files.create({
    requestBody: { name: fileName },
    media: { mimeType: 'image/jpeg', body: fs.createReadStream(filePath) },
    fields: 'id',
  });
  await drive.permissions.create({ fileId: created.data.id, requestBody: { role: 'reader', type: 'anyone' } });
  return `https://lh3.googleusercontent.com/d/${created.data.id}`;
}

// ---- common entry points -----------------------------------------------------
/**
 * images: [{ path, fileName, alt }] (index = position in the article)
 * Returns { urls: [url|null], featuredMediaId, note }
 */
async function uploadImages(account, images) {
  const urls = images.map(() => null);
  let featuredMediaId = null;
  const problems = [];
  for (let i = 0; i < images.length; i++) {
    try {
      if (account.platform === 'wordpress') {
        const r = await wpUploadImage(account, images[i].path, images[i].fileName, images[i].alt);
        urls[i] = r.url;
        if (!featuredMediaId) featuredMediaId = r.id;
      } else {
        urls[i] = await driveHostedImage(account.user_id, images[i].path, images[i].fileName);
      }
    } catch (err) {
      problems.push(err.message);
      logger.warn(`[website] image ${i + 1} upload failed: ${err.message}`);
      if (account.platform === 'blogger') break; // Drive problem would repeat for every picture
    }
  }
  const ok = urls.filter(Boolean).length;
  let note = null;
  if (images.length && ok < images.length) note = `${ok}/${images.length} pictures added. ${problems[0] || ''}`.trim();
  return { urls, featuredMediaId, note };
}

async function publishArticle(account, payload) {
  return account.platform === 'wordpress' ? wpCreatePost(account, payload) : bloggerPublish(account, payload);
}

module.exports = {
  normalizeSiteUrl, testWordPress, uploadImages, publishArticle,
  getBloggerOAuthClient, BLOGGER_SCOPES, bloggerErrorMessage,
};
