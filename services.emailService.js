const nodemailer = require('nodemailer');
const env = require('./config.env');
const logger = require('./utils.logger');

const transporter = nodemailer.createTransport({
  host: env.smtp.host,
  port: env.smtp.port,
  secure: env.smtp.secure,
  auth: env.smtp.user ? { user: env.smtp.user, pass: env.smtp.pass } : undefined,
});

async function sendEmail({ to, subject, html }) {
  try {
    await transporter.sendMail({ from: env.smtp.from, to, subject, html });
    logger.info(`Email sent to ${to}: ${subject}`);
  } catch (err) {
    logger.error(`Email send failed to ${to}: ${err.message}`);
  }
}

async function sendVerificationEmail(user, token) {
  const link = `${env.appUrl}/api/auth/verify-email?token=${token}`;
  await sendEmail({
    to: user.email,
    subject: 'Verify your Drive2Facebook account',
    html: `<p>Hi ${user.name},</p><p>Please verify your email by clicking <a href="${link}">this link</a>.</p>`,
  });
}

async function sendPasswordResetEmail(user, token) {
  const link = `${env.frontendUrl}/reset-password.html?token=${token}`;
  await sendEmail({
    to: user.email,
    subject: 'Reset your Drive2Facebook password',
    html: `<p>Hi ${user.name},</p><p>Reset your password by clicking <a href="${link}">this link</a>. This link expires in 1 hour.</p>`,
  });
}

async function sendUploadStatusEmail(user, { status, videoName, pageName }) {
  const subjectMap = { success: 'Video uploaded successfully', failure: 'Video upload failed', retry: 'Video upload retrying' };
  await sendEmail({
    to: user.email,
    subject: subjectMap[status] || 'Upload update',
    html: `<p>${videoName} to page "${pageName}" - status: <b>${status}</b>.</p>`,
  });
}

module.exports = { sendEmail, sendVerificationEmail, sendPasswordResetEmail, sendUploadStatusEmail };
