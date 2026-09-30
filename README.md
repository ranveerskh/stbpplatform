# STB Play shared platform (starter)

This standalone Node.js service provides a shared registration-key API, separate Android/Windows minimum-version settings, and a small admin dashboard. It does not modify or bundle either app.

## Run locally

Requires Node.js 22+ (Node 24 is recommended). `node:sqlite` is built into recent Node releases; Node may print an experimental-feature warning.

```sh
STB_ADMIN_KEY='use-a-long-random-secret-here' npm start
```

Open `http://localhost:8787`, enter the same admin key, then create a registration key. The SQLite database is created under `data/` by default. Keep that directory private and backed up.

## App API

- `GET /api/v1/config?platform=android|windows` returns that platform's minimum supported version and update link.
- `POST /api/v1/register` JSON: `licenseKey`, `deviceId`, `platform`, `appVersion`, optional `portalHost`.
- `POST /api/v1/heartbeat` JSON: `deviceId`, `platform`, `appVersion`, optional `portalHost`.
- `GET /api/health` is a basic health check.

Registration and heartbeat responses include `updateRequired`. Both apps must call this service and enforce that response (including an update-required screen) before an old build is blocked. Server-side settings alone cannot stop an app that never checks them. A clear retry path is needed when the service is temporarily unreachable.

## Admin API

Every `/admin/api/*` request requires `x-admin-key: <STB_ADMIN_KEY>`.

- `GET /admin/api/summary`, `GET /admin/api/keys`
- `POST /admin/api/keys` with `{ "label": "optional", "deviceLimit": 1 }`
- `PATCH /admin/api/keys/:id` with `{ "active": false }`
- `PUT /admin/api/settings` with minimum versions and update URLs for both platforms

The dashboard only retains the admin key for the current browser tab. Registration keys are stored as SHA-256 hashes; a newly generated key is displayed only once. Telemetry stores device ID, platform, app version, portal hostname, and timestamps. It does not collect portal credentials, full URLs, or watched titles.

## Before public deployment

Use HTTPS, set a strong random `STB_ADMIN_KEY`, configure deployment-level request rate limiting, restrict dashboard access, use persistent encrypted storage/backups, and rotate secrets if exposed. Review privacy policy and retention requirements. Add managed database/hosting and monitoring. Do not put this service on a public URL with the default or an empty admin key.

The API is an initial integration contract, not a complete production launch. Registration key policy, account/device recovery, admin roles, abuse limits, and hosting remain to be finalized. Android and Windows app integration must be released separately.
