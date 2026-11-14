const { query } = require('./config.database');
const { encrypt, decrypt } = require('./utils.encryption');

const ACCOUNT_PUBLIC = 'id, platform, name, site_url, wp_username, blog_id, google_user_email, connected_at';

const WebsiteAccount = {
  async createWordPress(userId, { name, siteUrl, username, appPassword }) {
    const res = await query(
      `INSERT INTO website_accounts (user_id, platform, name, site_url, wp_username, wp_app_password)
       VALUES ($1,'wordpress',$2,$3,$4,$5) RETURNING ${ACCOUNT_PUBLIC}`,
      [userId, name, siteUrl, username, encrypt(appPassword)]
    );
    return res.rows[0];
  },

  // One row per Blogger blog; reconnecting the same blog just refreshes its tokens.
  async upsertBlogger(userId, { name, siteUrl, blogId, email, accessToken, refreshToken, expiryTime, scope }) {
    const res = await query(
      `INSERT INTO website_accounts (user_id, platform, name, site_url, blog_id, google_user_email, access_token, refresh_token, expiry_time, scope)
       VALUES ($1,'blogger',$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id, blog_id) WHERE blog_id IS NOT NULL DO UPDATE SET
         name = EXCLUDED.name, site_url = EXCLUDED.site_url, google_user_email = EXCLUDED.google_user_email,
         access_token = EXCLUDED.access_token,
         refresh_token = COALESCE(EXCLUDED.refresh_token, website_accounts.refresh_token),
         expiry_time = EXCLUDED.expiry_time, scope = EXCLUDED.scope, updated_at = now()
       RETURNING ${ACCOUNT_PUBLIC}`,
      [userId, name, siteUrl || null, blogId, email || null, encrypt(accessToken), refreshToken ? encrypt(refreshToken) : null, expiryTime, scope]
    );
    return res.rows[0];
  },

  async listByUser(userId) {
    const res = await query(`SELECT ${ACCOUNT_PUBLIC} FROM website_accounts WHERE user_id = $1 ORDER BY connected_at`, [userId]);
    return res.rows;
  },

  // With decrypted secrets - only for server-side API calls.
  async findById(userId, id) {
    const res = await query('SELECT * FROM website_accounts WHERE user_id = $1 AND id = $2', [userId, id]);
    const row = res.rows[0];
    if (!row) return null;
    return {
      ...row,
      wp_app_password: row.wp_app_password ? decrypt(row.wp_app_password) : null,
      access_token: row.access_token ? decrypt(row.access_token) : null,
      refresh_token: row.refresh_token ? decrypt(row.refresh_token) : null,
    };
  },

  async updateTokens(id, { accessToken, refreshToken, expiryTime, scope }) {
    await query(
      `UPDATE website_accounts SET access_token = $2, refresh_token = COALESCE($3, refresh_token), expiry_time = $4,
         scope = COALESCE($5, scope), updated_at = now() WHERE id = $1`,
      [id, encrypt(accessToken), refreshToken ? encrypt(refreshToken) : null, expiryTime, scope || null]
    );
  },

  async remove(userId, id) {
    await query('DELETE FROM website_accounts WHERE user_id = $1 AND id = $2', [userId, id]);
  },
};

const SCHEDULE_COLS = `account_id, topic, language, article_length, image_count, publish_mode,
  upload_time, timezone, repeat_type, specific_days, interval_hours, times, share_page_ids, share_x_ids, share_fb_link_comment, share_x_link_reply, share_pinterest_ids`;

function scheduleParams(userId, d) {
  return [
    userId, d.accountId, d.topic, d.language || 'english', d.articleLength || 'medium',
    d.imageCount, d.publishMode || 'publish', d.uploadTime, d.timezone, d.repeat,
    d.specificDays && d.specificDays.length ? d.specificDays : null, d.intervalHours || null,
    d.times && d.times.length ? JSON.stringify(d.times) : null,
    d.sharePageIds && d.sharePageIds.length ? d.sharePageIds : null,
    d.shareXIds && d.shareXIds.length ? d.shareXIds : null,
    !!d.fbLinkComment, !!d.xLinkReply,
    d.sharePinterestIds && d.sharePinterestIds.length ? d.sharePinterestIds : null,
  ];
}

const WebsiteSchedule = {
  async create(userId, d) {
    const res = await query(
      `INSERT INTO website_schedules (user_id, ${SCHEDULE_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::uuid[],$15::uuid[],$16,$17,$18::uuid[]) RETURNING *`,
      scheduleParams(userId, d)
    );
    return res.rows[0];
  },

  async update(userId, id, d) {
    const res = await query(
      `UPDATE website_schedules SET account_id=$3, topic=$4, language=$5, article_length=$6, image_count=$7, publish_mode=$8,
         upload_time=$9, timezone=$10, repeat_type=$11, specific_days=$12, interval_hours=$13, times=$14, share_page_ids=$15::uuid[], share_x_ids=$16::uuid[], share_fb_link_comment=$17, share_x_link_reply=$18, share_pinterest_ids=$19::uuid[],
         last_run_slots='{}'::jsonb, last_run_at=NULL, updated_at=now()
       WHERE user_id=$1 AND id=$2 RETURNING *`,
      [userId, id, ...scheduleParams(userId, d).slice(1)]
    );
    return res.rows[0];
  },

  async listByUser(userId) {
    const res = await query(
      `SELECT s.*, a.name AS account_name, a.platform FROM website_schedules s
       LEFT JOIN website_accounts a ON a.id = s.account_id
       WHERE s.user_id = $1 ORDER BY s.created_at DESC`, [userId]);
    return res.rows;
  },

  async setActive(userId, id, isActive) {
    const res = await query('UPDATE website_schedules SET is_active=$3, updated_at=now() WHERE user_id=$1 AND id=$2 RETURNING *', [userId, id, isActive]);
    return res.rows[0];
  },

  async remove(userId, id) {
    await query('DELETE FROM website_schedules WHERE user_id = $1 AND id = $2', [userId, id]);
  },

  async listActiveWithAccount() {
    const res = await query(
      `SELECT s.*, a.name AS account_name FROM website_schedules s
       JOIN website_accounts a ON a.id = s.account_id WHERE s.is_active = TRUE`);
    return res.rows;
  },

  // Same atomic claim strategy as the other schedule tables.
  async claimSlot(id, slotKey, dateKey) {
    const res = await query(
      `UPDATE website_schedules
       SET last_run_slots = jsonb_set(COALESCE(last_run_slots,'{}'::jsonb), ARRAY[$2::text], to_jsonb($3::text), true), last_run_at = now()
       WHERE id = $1 AND COALESCE(last_run_slots ->> $2, '') IS DISTINCT FROM $3 RETURNING id`,
      [id, slotKey, dateKey]
    );
    return res.rows.length > 0;
  },

  async claimInterval(id, intervalSeconds) {
    const res = await query(
      `UPDATE website_schedules SET last_run_at = now()
       WHERE id = $1 AND (last_run_at IS NULL OR now() - last_run_at >= ($2 || ' seconds')::interval) RETURNING id`,
      [id, intervalSeconds]
    );
    return res.rows.length > 0;
  },
};

const WebsitePost = {
  async create(userId, d) {
    const res = await query(
      `INSERT INTO website_posts (user_id, account_id, schedule_id, topic, language, article_length, image_count, publish_mode, share_page_ids, share_x_ids, share_fb_link_comment, share_x_link_reply, share_pinterest_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid[],$10::uuid[],$11,$12,$13::uuid[]) RETURNING *`,
      [userId, d.accountId, d.scheduleId || null, d.topic, d.language || 'english', d.articleLength || 'medium', d.imageCount, d.publishMode || 'publish',
        d.sharePageIds && d.sharePageIds.length ? d.sharePageIds : null, d.shareXIds && d.shareXIds.length ? d.shareXIds : null, !!d.fbLinkComment, !!d.xLinkReply, d.sharePinterestIds && d.sharePinterestIds.length ? d.sharePinterestIds : null]
    );
    return res.rows[0];
  },

  async setStatus(id, status, extra = {}) {
    const res = await query(
      `UPDATE website_posts SET status=$2, title=COALESCE($3,title), url=COALESCE($4,url), excerpt=COALESCE($5,excerpt),
         image_note=COALESCE($6,image_note), error_message=$7, updated_at=now() WHERE id=$1 RETURNING *`,
      [id, status, extra.title || null, extra.url || null, extra.excerpt || null, extra.imageNote || null, extra.error || null]
    );
    return res.rows[0];
  },

  async setShareNote(id, note) {
    await query('UPDATE website_posts SET share_note=$2, updated_at=now() WHERE id=$1', [id, note]);
  },

  async listByUser(userId, limit = 50) {
    const res = await query(
      `SELECT p.*, a.name AS account_name, a.platform FROM website_posts p
       LEFT JOIN website_accounts a ON a.id = p.account_id
       WHERE p.user_id = $1 ORDER BY p.created_at DESC LIMIT $2`, [userId, limit]);
    return res.rows;
  },

  async findById(userId, id) {
    const res = await query('SELECT * FROM website_posts WHERE user_id=$1 AND id=$2', [userId, id]);
    return res.rows[0];
  },

  async remove(userId, id) {
    await query('DELETE FROM website_posts WHERE user_id=$1 AND id=$2', [userId, id]);
  },

  async recentTitles(accountId, topic, limit = 20) {
    const res = await query(
      `SELECT title FROM website_posts WHERE account_id=$1 AND topic=$2 AND title IS NOT NULL
       ORDER BY created_at DESC LIMIT $3`, [accountId, topic, limit]);
    return res.rows.map((r) => r.title);
  },

  // Rows left half-done by a restart can never finish (their in-memory queue is gone).
  async failStale() {
    const res = await query(
      `UPDATE website_posts SET status='failed', error_message='Interrupted by a server restart - please try again.', updated_at=now()
       WHERE status IN ('pending','writing','images','publishing') RETURNING id`);
    return res.rowCount;
  },
};

module.exports = { WebsiteAccount, WebsiteSchedule, WebsitePost };
