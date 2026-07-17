# Drive2Facebook Automation

Automatically uploads videos from Google Drive folders to selected Facebook Pages
on user-defined schedules.

**Stack:** Node.js/Express · PostgreSQL · Redis + BullMQ · Google OAuth/Drive API ·
Meta Graph API · vanilla HTML/CSS/JS frontend · Docker/PM2/Nginx for deployment.

## File layout

All files are delivered **flat** (no nested folders), using dot-prefixed names
to indicate their logical grouping — e.g. `controllers.authController.js`,
`routes.schedules.js`, `models.User.js`, `migrations.001_init_schema.sql`.
The Node backend requires these by exact filename, so this works as-is; nothing
needs to be moved into folders for the backend to run.

The frontend is the one exception: Express's static file server needs the
HTML/CSS/JS to live under `public/`. Files are delivered as `public.*.html`,
`public.*.js`, `public.*.css` — run `./setup-frontend.sh` once to move them
into `public/` with the prefix stripped.

## 1. Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Redis 6+
- A Google Cloud project with the Drive API enabled and OAuth 2.0 credentials
- A Meta Developer App with Facebook Login + Pages/video permissions
  (`pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
  `publish_video`, `business_management`) — some of these require App Review
  before they work for accounts other than test users/admins.

## 2. Local installation

```bash
npm install
cp .env.example .env
# edit .env with your real DB, Redis, Google, Facebook, and SMTP credentials

./setup-frontend.sh        # arranges the frontend into public/
node migrate-runner.js     # creates all database tables

npm run start               # starts the API server (server.js)
npm run worker               # in a second terminal: starts background workers
```

Visit `http://localhost:5000`.

## 3. Environment variables

See `.env.example` for the full list. Key ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_HOST` / `REDIS_PORT` | Redis connection (used by BullMQ) |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | Sign auth tokens — use long random values |
| `TOKEN_ENCRYPTION_KEY` | 32-character key used to AES-encrypt stored OAuth tokens |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | From Google Cloud Console |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` / `FACEBOOK_REDIRECT_URI` | From Meta for Developers |
| `SMTP_*` | Used for verification / password-reset / notification emails |

## 4. Database

`migrations.001_init_schema.sql` creates all tables described in the spec:
`users`, `google_tokens`, `facebook_tokens`, `pages`, `drive_folders`,
`folder_mapping`, `schedules`, `queue_jobs`, `upload_history`, `logs`,
`notifications`, `settings`. Run new migrations by adding another
`migrations.00N_description.sql` file and re-running `node migrate-runner.js`
(it executes every `migrations.*.sql` file in order).

## 5. Background workers

`jobs.worker-entry.js` starts all background workers in one process:

1. **Schedule Checker** (`jobs.scheduleChecker.js`) — runs every minute via
   `node-cron`, finds schedules whose time matches "now" in their timezone,
   scans the mapped Drive folder for unpublished videos, and enqueues upload jobs.
2. **Google Drive Scanner** — implemented inline within the schedule checker
   (`services.googleDriveService.js`) — lists folders/videos and filters out
   anything already recorded in `upload_history`.
3. **Facebook Upload Worker** (`jobs.uploadWorker.js`) — a BullMQ `Worker`
   with concurrency 3, exponential backoff, and 5 retry attempts. Downloads
   the video to a temp file, uploads it via the Graph API, deletes the temp
   file, and records the result.
4. **Notification Service** — runs inline in the upload worker
   (`services.notificationService.js`) — writes an in-app notification and,
   if the user has email alerts on, sends an email.
5. **Cleanup Service** (`jobs.cleanupWorker.js`) — hourly cron that deletes
   any stray temp files older than an hour.

Run it separately from the API process (`npm run worker`), so uploads keep
processing even if you restart or scale the API.

## 6. Duplicate-upload protection

`upload_history` has a unique constraint on `(drive_file_id, facebook_page_id)`.
Before queuing a file, the schedule checker filters out any Drive file ID that
already has a `success` row for that page, so the same video is never
published twice to the same Page.

## 7. Docker deployment

```bash
docker compose up -d --build
docker compose exec app node migrate-runner.js
```

This brings up the API, a dedicated worker container, PostgreSQL, Redis, and
an Nginx reverse proxy (see `docker-compose.yml` / `nginx.conf`). Update
`nginx.conf` with your real domain and TLS certificate paths before exposing
it publicly.

## 8. PM2 (non-Docker VPS) deployment

```bash
npm install --production
./setup-frontend.sh
node migrate-runner.js
pm2 start ecosystem.config.js
pm2 save
```

`ecosystem.config.js` runs the API in cluster mode (`d2f-api`) and the
background workers as a single fork process (`d2f-workers`) so schedule
checks aren't duplicated across cores. Put Nginx in front with TLS
(`nginx.conf` has a commented HTTPS server block using Let's Encrypt paths).

## 9. Security

- Passwords hashed with bcrypt (cost 12).
- Google/Facebook access & refresh tokens are AES-encrypted at rest
  (`utils.encryption.js`) using `TOKEN_ENCRYPTION_KEY`.
- Helmet, CORS (locked to `FRONTEND_URL`), and a global rate limiter
  (`middleware.security.js`) are applied to all `/api` routes.
- JWTs are set as `httpOnly` cookies; `csurf` middleware is available
  (`middleware.security.js`) for routes that need explicit CSRF protection
  beyond `SameSite=Lax` cookies.
- All input is validated with `express-validator`
  (`utils.validators.js`) before hitting controllers.

## 10. API reference

Base path: `/api`. All authenticated routes expect the `access_token` cookie
(set automatically on login) or an `Authorization: Bearer <token>` header.

### Auth — `/api/auth`
| Method | Path | Description |
|---|---|---|
| POST | `/register` | Create account, sends verification email |
| POST | `/login` | Returns JWT (also set as cookie) |
| POST | `/logout` | Clears auth cookies |
| GET | `/verify-email?token=` | Verifies email from emailed link |
| POST | `/forgot-password` | Sends password reset email |
| POST | `/reset-password` | Sets new password from reset token |
| GET | `/me` | Current user profile |

### Google — `/api/auth/google`
| Method | Path | Description |
|---|---|---|
| GET | `/connect` | Returns Google OAuth consent URL |
| GET | `/callback` | OAuth redirect target; stores tokens |
| POST | `/disconnect` | Removes stored Google tokens |

### Facebook — `/api/auth/facebook`
| Method | Path | Description |
|---|---|---|
| GET | `/connect` | Returns Meta OAuth consent URL |
| GET | `/callback` | OAuth redirect target; stores token, syncs Pages |
| POST | `/disconnect` | Removes stored Facebook token |

### Drive — `/api/drive`
| Method | Path | Description |
|---|---|---|
| GET | `/browse` | Re-scans Drive, saves/returns all folders |
| GET | `/search?q=` | Searches folders by name |
| GET | `/folders` | Returns previously saved folders (no API call) |

### Folder Mapping — `/api/folder-mapping`
| Method | Path | Description |
|---|---|---|
| POST | `/` | Link a Page to a Drive folder — body: `{ pageId, folderId }` |
| GET | `/` | List mappings |

### Pages — `/api/pages`
| Method | Path | Description |
|---|---|---|
| POST | `/sync` | Re-fetches Pages from Facebook |
| GET | `/` | List saved Pages |
| POST | `/:id/disconnect` | Marks a Page disconnected |

### Schedules — `/api/schedules`
| Method | Path | Description |
|---|---|---|
| POST | `/` | Create a schedule (see body shape below) |
| GET | `/` | List schedules |
| PATCH | `/:id/toggle` | Body: `{ isActive: boolean }` |
| DELETE | `/:id` | Delete a schedule |

Schedule create body:
```json
{
  "pageId": "uuid",
  "folderId": "uuid",
  "uploadTime": "14:30",
  "timezone": "Asia/Karachi",
  "repeat": "daily | weekly | monthly | specific_days",
  "specificDays": [1, 3, 5],
  "maxUploads": 1,
  "randomDelaySeconds": 0,
  "caption": "string",
  "hashtags": "#tag1 #tag2",
  "privacy": "PUBLISHED",
  "publishImmediately": true
}
```

### Queue — `/api/queue`
| Method | Path | Description |
|---|---|---|
| GET | `/status` | BullMQ job counts + this user's job rows |
| POST | `/pause` | Pause the upload queue |
| POST | `/resume` | Resume the upload queue |
| DELETE | `/:jobId` | Cancel a specific job |

### Uploads — `/api/uploads`
| Method | Path | Description |
|---|---|---|
| GET | `/history?limit=&offset=` | Paginated upload history |

### Logs — `/api/logs`
| Method | Path | Description |
|---|---|---|
| GET | `/?limit=&offset=` | Activity log entries |

### Settings — `/api/settings`
| Method | Path | Description |
|---|---|---|
| GET | `/` | Current settings |
| PUT | `/` | Update settings/timezone/language |

### Dashboard — `/api/dashboard`
| Method | Path | Description |
|---|---|---|
| GET | `/overview` | Stats, queue counts, recent activity for the dashboard |

### Notifications — `/api/notifications`
| Method | Path | Description |
|---|---|---|
| GET | `/` | List notifications |
| PATCH | `/:id/read` | Mark one as read |

## 11. What you still need to configure

This scaffold is functionally complete, but it can't run against real
accounts until you:

1. Create a Google Cloud project, enable the Drive API, and generate OAuth
   credentials with `GOOGLE_REDIRECT_URI` as an authorized redirect URI.
2. Create a Meta Developer App, add Facebook Login, request the Pages/video
   permissions listed above, and (for anyone outside your app's test users)
   submit it for App Review.
3. Provision a server with Node.js, PostgreSQL, and Redis running
   continuously — the schedule checker relies on the worker process staying
   up every minute.
4. Point a real domain at Nginx and add a TLS certificate for HTTPS.
