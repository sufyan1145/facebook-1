/**
 * After an article is published: AI-written captions (Vertex) -> Facebook Pages + X.
 * Every target is independent and best-effort: a failed share NEVER fails the article.
 * Returns a short human-readable note for the history table.
 */
const articleService = require('./services.websiteArticleService');
const facebookService = require('./services.facebookService');
const xService = require('./services.xService');
const Page = require('./models.Page');
const XAccount = require('./models.XAccount');
const logger = require('./utils.logger');

async function writeCaptions({ title, excerpt, topic, language }) {
  const prompt = `You write social media posts that promote a blog article.
Article title: ${title}
Article summary: ${excerpt || ''}
Niche/topic: ${topic}
Language: ${language && language !== 'auto' ? language : 'the same language as the article title'}

Return ONLY JSON: {"facebook": "...", "x": "..."}
- "facebook": 2-4 short sentences that make people want to read the article, a few fitting emojis, 2-4 hashtags at the end. Do NOT include any link.
- "x": ONE punchy post, at most 200 characters including hashtags, 1-2 hashtags, no link, no quotes around it.`;
  try {
    const j = await articleService.generateJson(prompt, { maxOutputTokens: 1200 });
    return { facebook: String(j.facebook || '').trim() || title, x: String(j.x || '').trim() || title };
  } catch (err) {
    logger.warn(`[social-share] caption AI failed, using the title: ${err.message}`);
    return { facebook: title, x: title };
  }
}

async function shareArticle({ userId, title, excerpt, topic, language, url, imagePath, pageIds, xIds }) {
  const fbIds = (pageIds || []).filter(Boolean);
  const xs = (xIds || []).filter(Boolean);
  if (!url || (!fbIds.length && !xs.length)) return null;

  const captions = await writeCaptions({ title, excerpt, topic, language });
  const ok = []; const bad = [];

  for (const id of fbIds) {
    try {
      const page = await Page.findById(userId, id);
      if (!page || !page.is_connected) throw new Error('page not connected');
      const message = `${captions.facebook}\n\n${url}`;
      if (imagePath) await facebookService.postPhotoToPage({ pageId: page.page_id, pageAccessToken: page.page_access_token, filePath: imagePath, message });
      else await facebookService.postLinkToPage({ pageId: page.page_id, pageAccessToken: page.page_access_token, message: captions.facebook, link: url });
      ok.push(`Facebook: ${page.page_name}`);
    } catch (err) { logger.warn(`[social-share] Facebook ${id} failed: ${err.message}`); bad.push(`Facebook (${err.message})`); }
  }

  for (const id of xs) {
    let name = 'X';
    try {
      const acc = await XAccount.findById(userId, id);
      if (!acc) throw new Error('account removed');
      name = `@${acc.username}`;
      await xService.postTweet(acc, { text: captions.x, url, imagePaths: imagePath ? [imagePath] : [] });
      ok.push(`X: ${name}`);
    } catch (err) { logger.warn(`[social-share] X ${name} failed: ${err.message}`); bad.push(`X ${name} (${err.message})`); }
  }

  const parts = [];
  if (ok.length) parts.push(`Shared on ${ok.join(', ')}.`);
  if (bad.length) parts.push(`Share failed: ${bad.join('; ')}.`);
  return parts.join(' ').slice(0, 480);
}

module.exports = { shareArticle };
