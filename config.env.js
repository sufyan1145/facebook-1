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
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    youtubeScopes: [
      'https://www.googleapis.com/auth/youtube.upload',
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
    // How many minutes late a schedule can still be caught and fired (covers deploys,
    // restarts, or a slow previous tick). Applies to daily/weekly/monthly/specific_days
    // AND multiple_times schedules alike, so no schedule silently skips a day.
    scheduleGraceMinutes: Number(process.env.SCHEDULE_GRACE_MINUTES) || 20,
    // How many schedules the checker evaluates/fires in parallel per tick, so a large
    // number of schedules (hundreds/thousands) due at the same minute doesn't serialize
    // behind slow Drive API calls and run past the next cron tick.
    scheduleCheckConcurrency: Number(process.env.SCHEDULE_CHECK_CONCURRENCY) || 15,
  },

  kie: {
    apiKey: process.env.KIE_API_KEY,
    baseUrl: process.env.KIE_BASE_URL || 'https://api.kie.ai',
    model: (process.env.KIE_VIDEO_MODEL || 'kling/v2-1-standard').trim(),
    imageModel: (process.env.KIE_IMAGE_MODEL || 'google/nano-banana').trim(),
    // veo3_fast = cheap/fast ($0.40/8s), veo3 = higher quality ($2/8s)
    veoModel: (process.env.KIE_VEO_MODEL || 'veo3_fast').trim(),
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

  videoDownload: {
    // Optional: a YouTube cookies.txt file, base64-encoded into one env
    // var (same trick as VERTEX_CREDENTIALS_BASE64 above, safe for
    // Railway). YouTube's "Sign in to confirm you're not a bot" block is
    // an IP-reputation/anti-bot check on cloud IPs like Railway's - real
    // browser cookies from a logged-in session are the standard yt-dlp
    // workaround. Export with a browser extension like "Get cookies.txt
    // LOCALLY", base64-encode the file, and set YTDLP_COOKIES_BASE64.
    // Leave unset to skip this (downloads still work for sites that don't
    // need it).
    cookiesBase64: process.env.YTDLP_COOKIES_BASE64,
  },

  vertexAi: {
    projectId: process.env.VERTEX_PROJECT_ID,
    location: (process.env.VERTEX_LOCATION || 'us-central1').trim(),
    // Full service-account JSON, base64-encoded, in one env var (safe for Railway).
    credentialsBase64: process.env.VERTEX_CREDENTIALS_BASE64,
    veoModel: (process.env.VERTEX_VEO_MODEL || 'veo-3.0-generate-preview').trim(),
    imageModel: (process.env.VERTEX_IMAGE_MODEL || 'gemini-2.5-flash-image').trim(),
    ttsModel: (process.env.VERTEX_TTS_MODEL || 'gemini-2.5-flash-preview-tts').trim(),
    scriptModel: (process.env.VERTEX_SCRIPT_MODEL || 'gemini-2.5-flash').trim(),
  },

  grok: {
    apiKey: process.env.XAI_API_KEY,
    videoModel: (process.env.GROK_VIDEO_MODEL || 'grok-imagine-video').trim(),
  },

  customTts: {
    // Your self-hosted Avatar Video Tool API (Kokoro TTS). Update this in
    // Railway every time the Cloudflare Tunnel restarts (its URL changes),
    // or once it's permanently hosted, point it there instead.
    apiUrl: (process.env.AVATAR_API_URL || '').trim().replace(/\/$/, ''),
  },

  transcribeDub: {
    // Your self-hosted Transcribe-Dub API (Whisper + NLLB + Kokoro), used by
    // the Video Editor's "Transcribe & Dub" feature. Same Cloudflare Tunnel
    // caveat as customTts.apiUrl above - update in Railway on every restart.
    apiUrl: (process.env.TRANSCRIBE_DUB_API_URL || '').trim().replace(/\/$/, ''),
  },

  contentPipeline: {
    checkCron: process.env.CONTENT_PIPELINE_CRON || '* * * * *',
    clipSeconds: Number(process.env.CONTENT_CLIP_SECONDS) || 10, // length of each generated video clip
    // 'video'          = AI text-to-video clips (Kie/Kling, costs credits per second of video)
    // 'veo'             = Google Veo3 via Kie.ai - cinematic, highly story-accurate (fixed ~8s clips, trimmed to fit)
    // 'vertex_veo'      = Google Veo3 via Vertex AI (own billing account/credit, not Kie.ai)
    // 'grok'            = xAI Grok Imagine text-to-video - cinematic, has a $175/month free credit program
    // 'image_kenburns' = one AI image per scene + pan/zoom effect (cheap/free depending on imageProvider)
    // 'stock_video'     = free real stock footage clip per scene (Pexels, no AI generation at all)
    // 'hybrid'          = try Pexels stock footage first; if no good match for that scene, fall back to an AI image + Ken Burns effect
    // 'veo_intro_kenburns' = only the first N scenes use Veo3 (Vertex), rest use image_kenburns (Nano Banana) - fast + cheap
    // Only used when clipMode === 'veo_intro_kenburns'. First N scenes render via Veo3.
    veoIntroScenes: Number(process.env.CONTENT_VEO_INTRO_SCENES) || 2,
    // The duration (seconds) requested FROM Veo3 itself for those intro scenes (kept short = faster/cheaper).
    // The final clip is still normalized/looped to match that scene's actual voiceover length, so sync is unaffected.
    veoIntroSeconds: Number(process.env.CONTENT_VEO_INTRO_SECONDS) || 4,
    // Burns short-form style animated captions (2-3 words at a time) onto every clip.
    captionsEnabled: (process.env.CONTENT_CAPTIONS_ENABLED || 'true').trim() === 'true',
    clipMode: (process.env.CONTENT_CLIP_MODE || 'video').trim(),
    // who generates the still image when clipMode is 'image_kenburns': 'kie' (paid credits), 'gemini' (free tier, may be 0 quota), 'pollinations' (free, no API key), or 'vertex' (Nano Banana via Vertex AI billing account)
    imageProvider: (process.env.IMAGE_PROVIDER || 'kie').trim(),
    // 'gemini' (AI Studio, simple API key) or 'vertex' (Cloud Text-to-Speech via Vertex AI billing account)
    ttsProvider: (process.env.TTS_PROVIDER || 'gemini').trim(),
    // 'gemini' (AI Studio API key, subject to its free-tier daily quota) or 'vertex'
    // (billing account, no free-tier daily cap - avoids "quota exceeded" errors)
    scriptProvider: (process.env.SCRIPT_PROVIDER || 'gemini').trim(),
  },
};
