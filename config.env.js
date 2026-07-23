require('dotenv').config();

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 5000,
  appUrl: process.env.APP_URL || 'http://localhost:5000',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5000',

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  cookieSecret: process.env.COOKIE_SECRET,
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY,

  db: {
    connectionString: process.env.DATABASE_URL,
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
  },

  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_REDIRECT_URI,
    scopes: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  },

  facebook: {
    appId: process.env.FACEBOOK_APP_ID,
    appSecret: process.env.FACEBOOK_APP_SECRET,
    redirectUri: process.env.FACEBOOK_REDIRECT_URI,
    graphVersion: process.env.FACEBOOK_GRAPH_VERSION || 'v19.0',
    scopes: [
      'email',
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_posts',
      'business_management',
    ],
  },

  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM || 'noreply@drive2facebook.app',
  },

  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
    max: Number(process.env.RATE_LIMIT_MAX) || 200,
  },

  upload: {
    tempDir: process.env.TEMP_UPLOAD_DIR || './uploads',
    scheduleCheckCron: process.env.SCHEDULE_CHECK_CRON || '* * * * *',
    maxRandomDelaySeconds: Number(process.env.MAX_RANDOM_DELAY_SECONDS) || 300,
  },

  kie: {
    apiKey: process.env.KIE_API_KEY,
    baseUrl: process.env.KIE_BASE_URL || 'https://api.kie.ai',
    model: (process.env.KIE_VIDEO_MODEL || 'kling/v2-1-standard').trim(),
    imageModel: (process.env.KIE_IMAGE_MODEL || 'google/nano-banana').trim(),
    pollCron: process.env.VIDEOGEN_POLL_CRON || '*/1 * * * *', // check every minute
  },

  googleAi: {
    geminiApiKey: process.env.GEMINI_API_KEY,
    geminiModel: (process.env.GEMINI_MODEL || 'gemini-2.0-flash').trim(),
    imageModel: (process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image').trim(),
    defaultVoice: process.env.GOOGLE_TTS_VOICE || 'Kore',
  },

  pexels: {
    apiKey: (process.env.PEXELS_API_KEY || '').trim(),
  },

  contentPipeline: {
    checkCron: process.env.CONTENT_PIPELINE_CRON || '* * * * *',
    clipSeconds: Number(process.env.CONTENT_CLIP_SECONDS) || 10, // length of each generated video clip
    // 'video'          = AI text-to-video clips (Kie/Kling, costs credits per second of video)
    // 'image_kenburns' = one AI image per scene + pan/zoom effect (cheap/free depending on imageProvider)
    // 'stock_video'     = free real stock footage clip per scene (Pexels, no AI generation at all)
    clipMode: (process.env.CONTENT_CLIP_MODE || 'video').trim(),
    // who generates the still image when clipMode is 'image_kenburns': 'kie' (paid credits), 'gemini' (free tier, may be 0 quota), or 'pollinations' (free, no API key)
    imageProvider: (process.env.IMAGE_PROVIDER || 'kie').trim(),
  },
};
