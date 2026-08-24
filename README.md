# Class Flow Cloud Server

Railway PostgreSQL server for Class Flow registration, activation, admin control, panel-wise Q&A usage, and chapter-wise Q&A cache.

## What This Handles

- Free school registration without OTP or payment.
- 6-month activation by default.
- Manual activation extension from admin side.
- School block/unblock.
- Per-panel monthly Q&A limit. Rollout default is 60 new generations per panel per month.
- Chapter-wise Q&A cache, so AI is needed only when cached Q&A does not exist.
- Cached Q&A does not count against the monthly Q&A limit.
- PostgreSQL storage for registrations, Panel Device IDs, activation, Q&A cache, and usage.

## Railway Setup

Create a Railway project with:

```text
Node.js service: classflow-cloud-server
PostgreSQL database: attached to the same project
```

Railway must provide `DATABASE_URL`. Add these variables in Railway:

```text
DATABASE_URL=<Railway PostgreSQL URL>
CLASSFLOW_DATABASE_SSL=false
CLASSFLOW_ADMIN_TOKEN=<strong private admin token>
BRANDING_ADMIN_PIN=1234
CLASSFLOW_DEFAULT_ACTIVATION_MONTHS=6
CLASSFLOW_DEFAULT_MONTHLY_QNA_LIMIT=60
GROQ_API_KEY=<server-side AI key>
GROQ_MODEL=openai/gpt-oss-20b
```

Railway start command:

```text
npm start
```

After deployment, Railway will give a public URL. Admin page:

```text
https://your-railway-url/admin
```

## Local Developer Run

This server now requires PostgreSQL. To run on laptop, set a real `DATABASE_URL` in `.env`, then start:

```powershell
cd D:\K-12content\classflow-cloud-server
npm.cmd start
```

The server automatically creates required tables on startup.

## AI Generation Modes

Default mode is cache-only. If Q&A is not saved, the app receives "not available yet".

Recommended free AI path: Groq server-side generation:

```powershell
npm.cmd start
```

When `GROQ_API_KEY` is saved in `.env`, the normal start command is enough.

Optional Gemini fallback:

```powershell
$env:GEMINI_API_KEY="your_google_ai_studio_key"
$env:GEMINI_MODEL="gemini-2.5-flash"
npm.cmd start
```

AI keys stay only on the server. They are never stored inside the APK.

## Main API Flow

1. App registers school using `POST /api/register`.
2. Server stores the school and Panel Device ID in PostgreSQL.
3. App checks activation using `POST /api/activation/check`.
4. App requests Q&A using `POST /api/qna/request`.
5. Server returns cached Q&A if available.
6. If cache is missing, server returns `QNA_NOT_FOUND`.
7. If AI is configured and cache is missing, server generates Q&A once, saves it, counts usage, and returns it.

## Rollout Q&A Control

Default monthly Q&A generation limit:

```text
CLASSFLOW_DEFAULT_MONTHLY_QNA_LIMIT=60
```

This means each registered panel can generate about 2 new Q&A sessions per day. If one school has 10-50 panels, each panel has its own monthly counter. If a Q&A set already exists in cache for the same chapter/settings, it is served from cache and is not counted again. Admin can increase or reduce the per-panel limit from the admin panel.

## Admin APIs

All admin APIs need header:

```text
X-Admin-Token: change-this-admin-token
```

- `GET /api/admin/schools`
- `GET /api/admin/schools.csv`
- `GET /api/admin/config`
- `GET /api/admin/usage`
- `POST /api/admin/schools/:schoolId/extend`
- `POST /api/admin/schools/:schoolId/block`
- `POST /api/admin/schools/:schoolId/unblock`
- `POST /api/admin/schools/:schoolId/qna-limit`
- `POST /api/admin/schools/:schoolId/update`
- `PUT /api/admin/qna`
- `GET /api/admin/qna`
- `DELETE /api/admin/qna/:cacheKey`

## Storage

PostgreSQL tables are created automatically:

- `schools`: school registration, Panel Device ID, activation, expiry, app version.
- `qna_cache`: chapter-wise generated/manual Q&A cache.
- `panel_usage`: monthly Q&A generation count per panel.

No production data depends on local JSON files.
