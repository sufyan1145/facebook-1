const { query } = require('./config.database');

const QueueJob = {
  async upsertFromBullJob(job, status, userId, scheduleId) {
    const res = await query(
      `INSERT INTO queue_jobs (user_id, schedule_id, bullmq_job_id, status, attempts)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [userId, scheduleId, String(job.id), status, job.attemptsMade || 0]
    );
    return res.rows[0];
  },

  async listByUser(userId) {
    const res = await query('SELECT * FROM queue_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200', [userId]);
    return res.rows;
  },
};

module.exports = QueueJob;
