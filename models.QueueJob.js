const { query } = require('./config.database');

const QueueJob = {
  async upsertFromBullJob(job, status, userId, scheduleId, errorMessage = null) {
    const res = await query(
      `INSERT INTO queue_jobs (user_id, schedule_id, bullmq_job_id, status, attempts, error_message)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (bullmq_job_id) DO UPDATE SET
         status = EXCLUDED.status,
         attempts = EXCLUDED.attempts,
         error_message = EXCLUDED.error_message,
         updated_at = now()
       RETURNING *`,
      [userId, scheduleId, String(job.id), status, job.attemptsMade || 0, errorMessage]
    );
    return res.rows[0];
  },

  async listByUser(userId) {
    const res = await query('SELECT * FROM queue_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200', [userId]);
    return res.rows;
  },
};

module.exports = QueueJob;
