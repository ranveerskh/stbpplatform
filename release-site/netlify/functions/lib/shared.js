import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const APP_NAME = "stb-play-release-site";
const COLLECTIONS = {
  admins: "admins",
  plans: "stbWebPlans",
  releases: "stbWebReleases",
  keyHashes: "stbWebKeyHashes",
  inventory: "stbWebKeyInventory",
  orders: "stbWebOrders",
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(statusCode, value) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(value),
  };
}

export function modernHandler(handler) {
  return async (request) => {
    const url = new URL(request.url);
    const event = {
      path: url.pathname,
      httpMethod: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      queryStringParameters: Object.fromEntries(url.searchParams.entries()),
      body: await request.text(),
      isBase64Encoded: false,
    };
    const result = await handler(event);
    return new Response(result.body || "", {
      status: result.statusCode || 200,
      headers: result.headers || {},
    });
  };
}

export function methodNotAllowed(allow) {
  return {
    ...json(405, { error: "Method not allowed." }),
    headers: { ...json(405, {}).headers, allow: allow.join(", ") },
  };
}

export function firebaseApp() {
  let app = getApps().find((candidate) => candidate.name === APP_NAME);
  if (!app) {
    let credential;
    const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (rawServiceAccount) {
      let serviceAccount;
      try { serviceAccount = JSON.parse(rawServiceAccount); }
      catch { throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON."); }
      credential = cert(serviceAccount);
    } else {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured.");
    }
    app = initializeApp({
      credential,
      projectId: process.env.FIREBASE_PROJECT_ID || "stbpplay-platform",
    }, APP_NAME);
  }
  return app;
}

export function db() {
  return getFirestore(firebaseApp());
}

function requestHeader(event, name) {
  const target = name.toLowerCase();
  const entry = Object.entries(event.headers || {}).find(([key]) => key.toLowerCase() === target);
  return entry?.[1] || "";
}

async function authorize(event) {
  const match = requestHeader(event, "authorization").match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, "Sign in with an authorized admin account.");
  let decoded;
  try { decoded = await getAuth(firebaseApp()).verifyIdToken(match[1], true); }
  catch { throw new HttpError(401, "Your sign-in session expired. Sign in again."); }
  const admin = await db().collection(COLLECTIONS.admins).doc(decoded.uid).get();
  if (!admin.exists || admin.data()?.active === false || admin.data()?.disabled === true) {
    throw new HttpError(403, "This Firebase account is not on the STB PLAY admin list.");
  }
  return { uid: decoded.uid, email: decoded.email || "" };
}

function readBody(event) {
  if (!event.body) return {};
  let raw = event.body;
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
  if (Buffer.byteLength(raw, "utf8") > 1_500_000) throw new HttpError(413, "Request is too large.");
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Body must be a JSON object.");
    return value;
  }
  catch { throw new HttpError(400, "Request body must be valid JSON."); }
}

export async function runAdmin(event, allowedMethods, handler) {
  if (!allowedMethods.includes(event.httpMethod)) return methodNotAllowed(allowedMethods);
  try {
    const user = await authorize(event);
    const result = await handler({
      db: db(),
      user,
      body: readBody(event),
      query: event.queryStringParameters || {},
      headers: event.headers || {},
    });
    return json(200, result ?? {});
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    return json(500, { error: "The request could not be completed." });
  }
}

export function serverTime() {
  return FieldValue.serverTimestamp();
}

export function safeDocument(snapshot) {
  const data = snapshot.data() || {};
  const result = { id: snapshot.id, ...data };
  for (const [key, value] of Object.entries(result)) {
    if (value && typeof value.toDate === "function") result[key] = value.toDate().toISOString();
  }
  return result;
}

export function publicPlan(plan) {
  return {
    id: plan.id,
    name: plan.name,
    priceCents: plan.priceCents,
    term: plan.term,
    summary: plan.summary,
    features: plan.features,
    featured: plan.featured,
    active: plan.active,
    portalLimit: plan.portalLimit,
    castIncluded: plan.castIncluded,
    sortOrder: plan.sortOrder,
  };
}

export function publicRelease(release) {
  return {
    id: release.id,
    platform: release.platform,
    version: release.version,
    releaseDate: release.releaseDate,
    title: release.title,
    downloadUrl: release.downloadUrl,
    notes: release.notes,
    active: release.active,
  };
}

function secretBytes() {
  const secret = process.env.STB_KEY_MASTER_SECRET || "";
  if (secret.length < 32) throw new Error("STB_KEY_MASTER_SECRET must be at least 32 characters.");
  return Buffer.from(secret, "utf8");
}

function encKey() {
  return createHash("sha256").update("stb-key-encryption-v1\0").update(secretBytes()).digest();
}

function hashKey() {
  return createHash("sha256").update("stb-key-inventory-hmac-v1\0").update(secretBytes()).digest();
}

export function keyDigest(key) {
  return createHmac("sha256", hashKey()).update(key.trim().toUpperCase()).digest("hex");
}

export function registrationKeyId(key) {
  return createHash("sha256").update(key).digest("hex");
}

export function validityMonthsForPlan(term) {
  if (term === "month") return 1;
  if (term === "year") return 12;
  if (term === "lifetime") return null;
  throw new HttpError(409, "This plan has no supported validity period.");
}

export function encryptKey(key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  const encrypted = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptKey(value) {
  const [version, ivText, tagText, encryptedText] = String(value || "").split(".");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) throw new Error("Encrypted key data is malformed.");
  const decipher = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
}

export function parsePlan(body) {
  const terms = new Set(["month", "year", "lifetime"]);
  const plan = {
    name: cleanString(body.name, "Plan name", 70),
    priceCents: Number(body.priceCents),
    term: String(body.term || ""),
    summary: cleanString(body.summary || "", "Description", 150, false),
    features: Array.isArray(body.features) ? body.features.map((feature) => cleanString(feature, "Feature", 90)).slice(0, 12) : [],
    portalLimit: Number(body.portalLimit || 1),
    sortOrder: Number(body.sortOrder || 0),
    castIncluded: Boolean(body.castIncluded),
    featured: Boolean(body.featured),
    active: body.active !== false,
    updatedAt: serverTime(),
  };
  if (!Number.isSafeInteger(plan.priceCents) || plan.priceCents < 0 || plan.priceCents > 99_999_999) throw new HttpError(400, "Price must be a valid amount in cents.");
  if (!terms.has(plan.term)) throw new HttpError(400, "Validity must be monthly, yearly, or lifetime.");
  if (!Number.isInteger(plan.portalLimit) || plan.portalLimit < 1 || plan.portalLimit > 50) throw new HttpError(400, "Portal limit must be between 1 and 50.");
  if (!Number.isInteger(plan.sortOrder) || plan.sortOrder < 0 || plan.sortOrder > 999) throw new HttpError(400, "Display order must be between 0 and 999.");
  return plan;
}

export function parseRelease(body) {
  const platforms = new Set(["windows", "android", "android-tv", "quest"]);
  const release = {
    platform: String(body.platform || ""),
    version: cleanString(body.version, "Version", 30),
    releaseDate: cleanString(body.releaseDate || "", "Release date", 10, false),
    title: cleanString(body.title, "Release title", 80),
    downloadUrl: cleanString(body.downloadUrl, "Download URL", 1200),
    notes: cleanString(body.notes || "", "Release notes", 1000, false),
    active: body.active !== false,
    updatedAt: serverTime(),
  };
  if (!platforms.has(release.platform)) throw new HttpError(400, "Choose a supported platform.");
  let url;
  try { url = new URL(release.downloadUrl); }
  catch { throw new HttpError(400, "Enter a valid HTTPS download URL."); }
  if (url.protocol !== "https:" || url.username || url.password) throw new HttpError(400, "Download links must use HTTPS.");
  if (release.releaseDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(release.releaseDate)) throw new HttpError(400, "Release date must use YYYY-MM-DD.");
    const date = new Date(`${release.releaseDate}T00:00:00.000Z`);
    if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== release.releaseDate) throw new HttpError(400, "Release date is not a valid calendar date.");
  }
  return release;
}

function cleanString(value, label, maxLength, required = true) {
  const text = String(value ?? "").trim();
  if (!text && required) throw new HttpError(400, `${label} is required.`);
  if (text.length > maxLength) throw new HttpError(400, `${label} is too long.`);
  return text;
}

export function validKey(value) {
  return typeof value === "string" && /^STB-[A-Z0-9][A-Z0-9-]{6,70}$/i.test(value.trim());
}

export function idempotencyDigest(uid, key) {
  return createHash("sha256").update(uid).update("\0").update(key).digest("hex");
}

export function headerValue(headers, name) {
  const target = name.toLowerCase();
  return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === target)?.[1] || "";
}

export { COLLECTIONS };
