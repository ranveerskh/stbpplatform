# STB Play shared Firebase platform

This repository hosts the shared admin dashboard and backend for the Android and Windows apps. It uses Firebase Hosting, Firebase Authentication, Cloud Functions, and Cloud Firestore. Each app keeps its own release/update channel; the platform shares registration keys, device status, and minimum-version rules.

## Firebase Console setup

1. In Authentication, enable **Email/Password**. Create the admin account if you have not already.
2. Create a **Cloud Firestore** database in production mode. Functions are configured in `northamerica-northeast1`; choose a nearby Canadian Firestore location if available. Firestore location cannot be changed after creation.
3. In Firestore, add collection `admins`. Add a document whose document ID is the admin user's **UID** from Authentication. Set fields: `active` (boolean) = `true`, and `role` (string) = `admin`.
4. In Firestore Rules, publish the rules from `firestore.rules` (deny direct client reads/writes; all access goes through authorized Cloud Functions).
5. The Web app config is in `public/firebase-config.js`. Firebase web config/API key identifies the project; it is not a server secret. Firestore rules and admin checks protect data.

This app does not use **Realtime Database**. If you enabled it by accident, its safe deny-all rules are in `database.rules.json`; do not put app records there.

## Deploy

Install Node.js 22+, then in this repository:

```sh
npm install
cd functions && npm install && cd ..
npx firebase-tools login
npx firebase-tools deploy --only firestore:rules,firestore:indexes,functions,hosting
```

Firebase Functions deployment requires a linked billing account (Blaze); it has usage-based pricing. Set Google Cloud budget alerts before deploying and review actual service pricing for expected traffic.

## Admin dashboard

Open the Firebase Hosting URL and sign in with the Email/Password account. The account must have an active document at `admins/{uid}`. From the dashboard, issue/revoke registration keys and set separate Android and Windows minimum versions/update URLs. A registration key is shown only once; the database stores its SHA-256 hash, not the original key.

## App API

Firebase Hosting rewrites `/api/**` to the `appApi` HTTPS function:

- `GET /api/config?platform=android|windows&version=x.y.z`
- `POST /api/register` JSON: `licenseKey`, `deviceId`, `platform`, `appVersion`, optional `portalHost`
- `POST /api/heartbeat` JSON: `licenseKey`, `deviceId`, `platform`, `appVersion`, optional `portalHost`

Responses carry `updateRequired`, `minimumVersion`, and `updateUrl`. Each app must integrate the API and block outdated use with its own update-required UI; a setting in Firebase cannot stop an app that never checks it. If a check cannot reach the service, apps should show retry and preserve local settings/data.

Device IDs should be random per installation. Only portal hostname, app version, platform, anonymous installation ID hash, and timestamps are retained; do not send/store portal credentials, MAC addresses, full URLs/query strings, raw IPs, or watched titles. The Windows app needs HTTPS requests to the function; no admin key or service-account secret belongs inside either app.

## Current setup limits

The web dashboard and backend source are ready for deployment. Firebase Console setup, Functions/Hosting deployment, domain setup, and Android/Windows client integration are still required. Turn on appropriate App Check protections for supported clients before public launch; also review Firebase Authentication authorized domains and API key restrictions. Test rules and app update behavior before relying on remote version enforcement.
