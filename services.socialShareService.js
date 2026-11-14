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
const PinterestAccount = require('./models.PinterestAccount');
const pinterestService = require('./services.pinterestService');
const logger = require('./utils.logger');

async function writeCaptions({ title, excerpt, topic, language }) {
  const prompt = `You write social media posts that promote a blog article.
Article title: ${title}
Article summary: ${excerpt || ''}
Niche/topic: ${topic}
Language: ${language && language !== 'auto' ? language : 'the same language as the article title'}

Return ONLY JSON: {"facebook": "...", "x": "...", "cta": "...", "pin_title": "...", "pin_description": "...", "pin_overlay": "..."}
- "facebook": 2-4 short sentences that make people want to read the article, a few fitting emojis, 2-4 hashtags at the end. Do NOT include any link.
- "x": ONE punchy post, at most 200 characters including hashtags, 1-2 hashtags, no link, no quotes around it.
- "cta": a short call to action of 3-7 words with one emoji (like "Read the full story here 👇"), in the same language, no link.
- "pin_title": a Pinterest SEO title with the main keyword near the start, at most 95 characters, no hashtags, no link.
- "pin_description": 2-3 sentences with natural search keywords people type on Pinterest, at most 450 characters, then 3-5 hashtags, no link.
- "pin_overlay": a 4-9 word headline to print on the Pin picture, same language as the title.`;
  try {
    const j = await articleService.generateJson(prompt, { maxOutputTokens: 1800 });
    return { facebook: String(j.facebook || '').trim() || title, x: String(j.x || '').trim() || title, cta: String(j.cta || '').trim().slice(0, 80) || 'Read the full article 👇',
      pinTitle: String(j.pin_title || '').trim().slice(0, 100) || title, pinDescription: String(j.pin_description || '').trim() || String(excerpt || title), pinOverlay: String(j.pin_overlay || '').trim() || title };
  } catch (err) {
    logger.warn(`[social-share] caption AI failed, using the title: ${err.message}`);
    return { facebook: title, x: title, cta: 'Read the full article 👇', pinTitle: title, pinDescription: String(excerpt || title), pinOverlay: title };
  }
}

async function shareArticle({ userId, title, excerpt, topic, language, url, imagePath, pageIds, xIds, pinterestIds, fbLinkComment = false, xLinkReply = false }) {
  const fbIds = (pageIds || []).filter(Boolean);
  const xs = (xIds || []).filter(Boolean);
  const pins = (pinterestIds || []).filter(Boolean);
  if (!url || (!fbIds.length && !xs.length && !pins.length)) return null;

  const captions = await writeCaptions({ title, excerpt, topic, language });
  const ok = []; const bad = [];

  for (const id of fbIds) {
    try {
      const page = await Page.findById(userId, id);
      if (!page || !page.is_connected) throw new Error('page not connected');
      const creds = { pageId: page.page_id, pageAccessToken: page.page_access_token };
      let note = '';
      if (fbLinkComment) {
        // the post itself has NO link (reaches more people); the link goes in the first comment
        const postId = imagePath
          ? await facebookService.postPhotoToPage({ ...creds, filePath: imagePath, message: captions.facebook })
          : await facebookService.postLinkToPage({ ...creds, message: captions.facebook });
        try {
          await facebookService.commentOnVideo({ videoId: postId, pageAccessToken: page.page_access_token, message: `${captions.cta}\n${url}` });
          note = ' (link in comment)';
        } catch (cErr) {
          logger.warn(`[social-share] Facebook ${page.page_name}: link comment failed: ${cErr.message}`);
          note = ` (posted, but the link comment failed: ${String(cErr.message).slice(0, 120)} - link: ${url})`;
        }
      } else {
        const message = `${captions.facebook}\n\n${url}`;
        if (imagePath) await facebookService.postPhotoToPage({ ...creds, filePath: imagePath, message });
        else await facebookService.postLinkToPage({ ...creds, message: captions.facebook, link: url });
      }
      ok.push(`Facebook: ${page.page_name}${note}`);
    } catch (err) { logger.warn(`[social-share] Facebook ${id} failed: ${err.message}`); bad.push(`Facebook (${err.message})`); }
  }

  for (const id of xs) {
    let name = 'X';
    try {
      const acc = await XAccount.findById(userId, id);
      if (!acc) throw new Error('account removed');
      name = `@${acc.username}`;
      const imgs = imagePath ? [imagePath] : [];
      // xLinkReply: the tweet has no link (X shows such tweets to more people); the link is a reply to it.
      const replyOnly = async (label) => {
        const first = await xService.postTweet(acc, { text: captions.x, imagePaths: imgs });
        try {
          await xService.postTweet(acc, { text: captions.cta, url, replyTo: first.id });
          ok.push(`X: ${name} (${label})`);
        } catch (err2) {
          ok.push(`X: ${name} (text only - X blocked the link: ${url})`);
          logger.warn(`[social-share] X ${name}: link reply blocked too: ${err2.message}`);
        }
      };
      if (xLinkReply) {
        await replyOnly('link in reply');
      } else {
        try {
          await xService.postTweet(acc, { text: captions.x, url, imagePaths: imgs });
          ok.push(`X: ${name}`);
        } catch (err) {
          // 226 = X's anti-automation filter, very often triggered by a link in a fresh tweet.
          if (!(err.xCode === 226 || err.emptyResult || /automated|\(226\)/i.test(err.message))) throw err;
          logger.warn(`[social-share] X ${name}: link tweet blocked/dropped by X, posting text first and the link as a reply`);
          await replyOnly('link in reply');
        }
      }
    } catch (err) { logger.warn(`[social-share] X ${name} failed: ${err.message}`); bad.push(`X ${name} (${err.message})`); }
  }

  // Pinterest: a 2:3 Pin with SEO title/description, linking to the article (needs the article picture).
  for (const id of pins) {
    let name = 'Pinterest';
    try {
      const acc = await PinterestAccount.findById(userId, id);
      if (!acc) throw new Error('account not connected');
      name = `@${acc.username}`;
      if (!imagePath) throw new Error('a Pin needs a picture - it is created for new articles, not for "Share" of old ones');
      const pin = await pinterestService.createPin(acc, {
        imagePath, title: captions.pinTitle, description: captions.pinDescription, altText: captions.pinTitle, link: url, overlayTitle: captions.pinOverlay,
      });
      ok.push(`Pinterest: ${name}`);
      logger.info(`[social-share] Pinterest ${name}: pin ${pin.id}`);
    } catch (err) { logger.warn(`[social-share] Pinterest ${name} failed: ${err.message}`); bad.push(`Pinterest ${name} (${err.message})`); }
  }

  const parts = [];
  if (ok.length) parts.push(`Shared on ${ok.join(', ')}.`);
  if (bad.length) parts.push(`Share failed: ${bad.join('; ')}.`);
  return parts.join(' ').slice(0, 480);
}

module.exports = { shareArticle };
