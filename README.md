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

Open the Netlify URL and sign in with the Email/Password account. The account must have an active document at `admins/{uid}`. From the dashboard, issue/revoke registration keys, choose an exact expiry date/time, and set separate Android and Windows minimum versions/update URLs. The dashboard shows opted-in Android installation activity for the last 24 hours, 7 days, 30 days, and 12 months; licensed devices are listed separately. These are device/install counts, not verified individual people. Free Windows installs are not counted until the Windows app integrates the usage heartbeat. A registration key is shown only once; the database stores its SHA-256 hash, not the original key.

## App API

Netlify proxies `/api/**` to the `appApi` HTTPS function:

- `GET /api/config?platform=android|windows&version=x.y.z`
- `POST /api/register` JSON: `licenseKey`, `deviceId`, `platform`, `appVersion`, optional `portalHost`
- `POST /api/heartbeat` JSON: `licenseKey`, `deviceId`, `platform`, `appVersion`, optional `portalHost`
- `POST /api/usage/heartbeat` JSON: `deviceId`, `platform`, `appVersion`; clients should send this only after obtaining the user's consent for basic usage counts.

Responses carry `updateRequired`, `minimumVersion`, and `updateUrl`. Each app must integrate the API and block outdated use with its own update-required UI; a setting in Firebase cannot stop an app that never checks it. If a check cannot reach the service, apps should show retry and preserve local settings/data.

Device IDs should be pseudonymous and must never contain credentials or personal data; the backend hashes them before storing usage or licence device records. Usage records expire after 12 months without a heartbeat. Licence registration records retain only the portal hostname (not the full URL), app version, platform, the device ID hash, and activity timestamps; do not send/store portal credentials, MAC addresses, full URLs/query strings, raw IPs, or watched titles. The Windows app needs HTTPS requests to the function; no admin key or service-account secret belongs inside either app.

## Current setup limits

The web dashboard and backend source are ready for deployment. Firebase Console setup, Functions deployment, Netlify site connection/domain setup, and Android/Windows client integration are still required. Turn on appropriate App Check protections for supported clients before public launch; also review Firebase Authentication authorized domains and API key restrictions. Test rules and app update behavior before relying on remote version enforcement.
