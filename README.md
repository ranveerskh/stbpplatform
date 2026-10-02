# STB Play shared Firebase platform

This repository contains the Netlify-hosted admin dashboard and Firebase backend for the Android and Windows apps. Netlify serves the static dashboard and proxies `/api/*`; Firebase Authentication, Cloud Functions, and Cloud Firestore handle login, validation, and shared data. Each app keeps its own release/update channel; the platform shares registration keys, device status, and minimum-version rules.

## Firebase Console setup

1. In Authentication, enable **Email/Password**. Create the admin account if you have not already.
2. Create a **Cloud Firestore** database in production mode. Functions are configured in `northamerica-northeast1`; choose a nearby Canadian Firestore location if available. Firestore location cannot be changed after creation.
3. In Firestore, add collection `admins`. Add a document whose document ID is the admin user's **UID** from Authentication. Set fields: `active` (boolean) = `true`, and `role` (string) = `admin`.
4. In Firestore Rules, publish the rules from `firestore.rules` (deny direct client reads/writes; all access goes through authorized Cloud Functions).
5. The Web app config is in `public/firebase-config.js`. Firebase web config/API key identifies the project; it is not a server secret. Firestore rules and admin checks protect data.
6. After Netlify gives you a site URL, add that hostname under Authentication → Settings → Authorized domains (for example, `your-site.netlify.app`).

This app does not use **Realtime Database**. If you enabled it by accident, its safe deny-all rules are in `database.rules.json`; do not put app records there.

## Deploy

Connect this GitHub repository to Netlify. The included `netlify.toml` publishes the `public` folder without a build step. Netlify's external rewrite proxies `/api/*` to the Firebase HTTPS function while the visible website remains on Netlify.

Install Node.js 22+, then in this repository to deploy only the Firebase backend and rules:

```sh
npm install
cd functions && npm install && cd ..
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules,firestore:indexes,functions
```

Firebase Functions deployment requires a linked billing account (Blaze); it has usage-based pricing. Set Google Cloud budget alerts before deploying and review actual service pricing for expected traffic.

## Admin dashboard

Open the Netlify URL and sign in with Firebase Email/Password. Admin access still requires an active `admins/{uid}` document with `role: "admin"`. The dashboard supports Admin-created distributors, Distributor-created resellers, Reseller-created providers, credit transfers, and permitted role changes. Account creation returns a one-time password setup link; share it securely with that account owner. Admin tools still issue/revoke manual registration keys and manage minimum app versions. A manual registration key is shown only once; Firestore stores its SHA-256 hash, not the original key.

The partner backend enforces these agreed limits by default: Distributor creation starts at 500 credits or more; each Distributor-to-Reseller allocation is capped at 250; each Reseller-to-Provider transfer is at least 20. Admin can change these in the dashboard. One Provider credit issues a 12-month single-device license when a device completes pairing. License grace lasts seven days after expiry. The Provider dashboard now supports portal profiles, pairing customers, viewing assigned-device/license/portal expiry status, and renewing a license for one credit. Android/Windows pairing client integration is still pending.

## App API

Netlify proxies `/api/**` to the `appApi` HTTPS function:

- `GET /api/config?platform=android|windows&version=x.y.z`
- `POST /api/register` JSON: `licenseKey`, `deviceId`, `platform`, `appVersion`, optional `portalHost`
- `POST /api/heartbeat` JSON: `licenseKey`, `deviceId`, `platform`, `appVersion`, optional `portalHost`
- `POST /api/usage/heartbeat` JSON: `deviceId`, `platform`, `appVersion`; clients should send this only after obtaining the user's consent for basic usage counts.
- `POST /api/pairing/start` JSON: `deviceId`, `platform`; returns a short-lived pairing code and a device token.
- `POST /api/pairing/status` JSON: `deviceId`, `pairingCode`, `deviceToken`; returns the assigned license and portal profile after provider pairing.
- `POST /api/device/sync` JSON: `deviceId`, `deviceToken`, `platform`, `appVersion`; returns license, portal assignment, and minimum-version status.

Responses carry `updateRequired`, `minimumVersion`, and `updateUrl`. Each app must integrate the API and block outdated use with its own update-required UI; a setting in Firebase cannot stop an app that never checks it. If a check cannot reach the service, apps should show retry and preserve local settings/data.

Device IDs should be pseudonymous and must never contain credentials or personal data; the backend hashes them before storing usage or license device records. Usage records expire after 12 months without a heartbeat. Manual license registration records retain the portal hostname, app version, platform, device ID hash, and activity timestamps. Provider-managed mode stores the provider's portal profile URL so an assigned app can sync it; the profile is returned only to the paired device, and portal URLs are not written to logs or analytics. Do not put portal usernames/passwords in URLs, and never collect the handset's Wi-Fi MAC, raw IPs, or watched titles. The customer shares only the app-generated portal MAC/service ID with their provider for authorization in the provider's own service panel. No Admin key or service-account secret belongs inside either app.

## Current setup limits

The backend and dashboard changes are local source changes and have not been deployed or tested against the live Firebase project. Before public use, deploy to a test project, configure App Check and authentication, and complete Android/Windows client pairing integration. Review the privacy notice to describe provider profile URL storage before enabling provider-managed mode. Then test credit limits, role transitions, pairing, expiry/grace, and update enforcement end to end.
