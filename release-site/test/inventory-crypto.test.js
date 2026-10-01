import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.STB_KEY_MASTER_SECRET = "unit-test-master-secret-for-stbplay-inventory-0001";
const { decryptKey, encryptKey, keyDigest, modernHandler, parsePlan, parseRelease, registrationKeyId, validKey, validityMonthsForPlan } = await import("../netlify/functions/lib/shared.js");

test("inventory encryption round-trips without storing the clear key", () => {
  const key = "STB-AB12-CD34-EF56";
  const encrypted = encryptKey(key);
  assert.equal(decryptKey(encrypted), key);
  assert.equal(encrypted.includes(key), false);
});

test("inventory digest treats key letter case consistently", () => {
  assert.equal(keyDigest("STB-AB12-CD34-EF56"), keyDigest("stb-ab12-cd34-ef56"));
});

test("import key reference matches the existing Firebase SHA-256 key ID", () => {
  const key = "STB-0123456789ABCDEF0123456789ABCDEF";
  assert.equal(registrationKeyId(key), createHash("sha256").update(key).digest("hex"));
});

test("only generated STB-format keys enter inventory", () => {
  assert.equal(validKey("STB-AB12-CD34-EF56"), true);
  assert.equal(validKey("someone@example.com"), false);
  assert.equal(validKey("STB-"), false);
});

test("optional plan and release fields may be blank", () => {
  const plan = parsePlan({ name: "Premium", priceCents: 199, term: "month" });
  assert.equal(plan.summary, "");
  const release = parseRelease({ platform: "windows", version: "1.0", title: "STB PLAY", downloadUrl: "https://example.com/app" });
  assert.equal(release.releaseDate, "");
  assert.equal(release.notes, "");
});

test("Netlify request adapter preserves method, query, auth header, and response", async () => {
  const handler = modernHandler(async (event) => ({
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: event.httpMethod, id: event.queryStringParameters.id, auth: event.headers.authorization, body: event.body }),
  }));
  const response = await handler(new Request("https://example.net/api/admin/plans?id=p1", {
    method: "POST",
    headers: { authorization: "Bearer test-token" },
    body: JSON.stringify({ name: "test" }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    method: "POST", id: "p1", auth: "Bearer test-token", body: JSON.stringify({ name: "test" }),
  });
});

test("release links reject insecure HTTP", () => {
  assert.throws(() => parseRelease({
    platform: "windows", version: "1.0", title: "STB PLAY", downloadUrl: "http://example.com/app",
  }), /HTTPS/);
});

test("release dates reject impossible calendar days", () => {
  assert.throws(() => parseRelease({
    platform: "android", version: "1.0", title: "STB PLAY", downloadUrl: "https://example.com/app", releaseDate: "2026-02-30",
  }), /valid calendar date/);
});

test("membership validity maps to calendar months", () => {
  assert.equal(validityMonthsForPlan("month"), 1);
  assert.equal(validityMonthsForPlan("year"), 12);
  assert.equal(validityMonthsForPlan("lifetime"), null);
  assert.throws(() => validityMonthsForPlan("week"), /validity period/);
});
