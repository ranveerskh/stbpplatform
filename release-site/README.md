# STB PLAY release site

Responsive downloads and membership-key site for GitHub + Netlify, connected to the existing STB PLAY license project `stbpplay-platform`.

## Included

- Public HTTPS download links for Windows, Android, Android TV, and Meta Quest.
- Editable CAD membership plans. Starter prices are $4.99 yearly for one portal, $1.99 monthly Premium, and $19.99 yearly Premium with casting.
- Firebase Google sign-in for admins, checked server-side against the existing `admins/{uid}` documents in `stbpplay-platform`.
- A separate Firestore namespace for site plans, releases, hashed inventory IDs, encrypted inventory keys, and orders.
- Import of actual keys from the existing Firebase `adminCreateKey` generator.
- Manual key assignment after an admin confirms payment. Online checkout is not connected.

## First-use validity

The first-use activation change in `ranveerskh/stbpplatform` must be deployed before membership keys are offered. It adds `activatedAt` and an expiry only on the first successful `/api/register`, after the device-limit check succeeds. Monthly validity uses one calendar month; yearly validity uses 12 calendar months. Existing keys without the new activation policy keep their current behavior. The registration response also includes plan ID/name, portal limit, and cast entitlement so compatible app builds can apply those plan rules.

When a generated key is imported, the site verifies that the existing `registrationKeys/{sha256(key)}` record is active, has no fixed expiry, has not been activated, and has no registered devices. It then applies that plan's validity period and entitlement metadata to the unused key in the same Firestore transaction that puts it in site inventory. If any key in a batch is not eligible, the batch is not imported. Existing active/expiry/device fields are not overwritten.

## Run locally

```sh
npm install
npm run dev
```

The public page has sample prices in local preview. Admin sign-in and Firebase-backed data require the environment variables below and run through Netlify Functions.

## Deploy with GitHub and Netlify

1. Connect the `stbpplay-platform` Firebase project and confirm the intended admin account has an `admins/{uid}` document.
2. Merge and deploy the first-use validity update from the `functions/` folder in `ranveerskh/stbpplatform`. The Firebase app registration change must be live before importing membership keys.
3. In Netlify, connect the GitHub repository containing this site. If it is in the `release-site/` subfolder of `stbpplatform`, set the Netlify base directory to `release-site`.
4. Set the build command to `npm run build` and publish directory to `dist`; the included `netlify.toml` also provides these settings when `release-site` is the base directory.
5. Add the Firebase web app values as Netlify environment variables: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID=stbpplay-platform`, and `VITE_FIREBASE_APP_ID`.
6. Add `FIREBASE_PROJECT_ID=stbpplay-platform`, `FIREBASE_SERVICE_ACCOUNT_JSON`, and `STB_KEY_MASTER_SECRET` as server-only Netlify environment variables. Never place the service-account JSON or master secret in GitHub, browser code, or a `VITE_` variable.
7. Enable Google sign-in in Firebase Authentication and add the Netlify domain to the project's authorized domains.
8. Deploy. The first authorized Admin overview seeds the three starter plans if the site's plan collection is empty. Publish actual HTTPS app download links, then import unused keys from the existing generator.

`FIREBASE_SERVICE_ACCOUNT_JSON` must contain the service-account JSON text. Generate a strong `STB_KEY_MASTER_SECRET` of at least 32 characters and keep it unchanged while inventory exists; changing it without re-encrypting inventory makes stored keys unreadable. Store both only in Netlify's encrypted environment settings. The Admin SDK credential can access the Firebase project, so limit access to Netlify and its GitHub repository to trusted maintainers.

The site does not change Firestore Security Rules. It writes only the named `stbWeb…` collections and, for eligible imported keys, the new validity metadata in `registrationKeys`. First registration writes `activatedAt` and `expiresAt` from the deployed Firebase function.

## Inventory and sales

- Import 1–100 `STB-…` keys per request; CSV reads the first column and supports an optional `key` header.
- Duplicate keys are detected across imports without exposing the original value in document IDs. Inventory keys are encrypted with AES-256-GCM; the HMAC key digest is used for lookup.
- The admin overview shows counts, not available key text.
- After you confirm payment, assignment moves one key from `available` to `assigned` in a Firestore transaction. Retrying the same request ID will not consume a second key.
- The assigned code is returned to the signed-in admin to send to the buyer. The public purchase buttons remain disabled, and the manual admin flow does not charge customers.
