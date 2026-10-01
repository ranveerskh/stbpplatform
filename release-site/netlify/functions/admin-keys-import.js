import { COLLECTIONS, HttpError, encryptKey, keyDigest, modernHandler, registrationKeyId, runAdmin, serverTime, validKey, validityMonthsForPlan } from "./lib/shared.js";

const IMPORT_CHUNK_SIZE = 100;

async function handler(event) {
  return runAdmin(event, ["POST"], async ({ db, body }) => {
    const planId = String(body.planId || "").trim();
    const inputKeys = body.keys;
    if (!planId || planId.includes("/") || planId.length > 120) throw new HttpError(400, "Choose a valid membership plan.");
    if (!Array.isArray(inputKeys) || inputKeys.length < 1 || inputKeys.length > IMPORT_CHUNK_SIZE) throw new HttpError(400, "Import between 1 and 100 keys at a time.");
    const planRef = db.collection(COLLECTIONS.plans).doc(planId);

    const unique = new Map();
    let duplicates = 0;
    for (const raw of inputKeys) {
      const key = typeof raw === "string" ? raw.trim() : "";
      if (!validKey(key)) throw new HttpError(400, "Every key must be a valid STB-… key. No keys were imported.");
      const digest = keyDigest(key);
      if (unique.has(digest)) { duplicates += 1; continue; }
      unique.set(digest, { key, digest });
    }

    const entries = [...unique.values()];
    let imported = 0;
    for (let start = 0; start < entries.length; start += IMPORT_CHUNK_SIZE) {
      const chunk = entries.slice(start, start + IMPORT_CHUNK_SIZE);
      const result = await db.runTransaction(async (transaction) => {
        const licenseRefs = chunk.map((entry) => db.collection("registrationKeys").doc(registrationKeyId(entry.key)));
        const [planSnapshot, ...snapshots] = await transaction.getAll(
          planRef,
          ...chunk.map((entry) => db.collection(COLLECTIONS.keyHashes).doc(entry.digest)),
          ...licenseRefs,
        );
        if (!planSnapshot.exists) throw new HttpError(404, "Membership plan no longer exists.");
        const validityMonths = validityMonthsForPlan(planSnapshot.data().term);
        const hashSnapshots = snapshots.slice(0, chunk.length);
        const licenseSnapshots = snapshots.slice(chunk.length);
        const deviceSnapshots = await Promise.all(chunk.map((entry, index) =>
          hashSnapshots[index].exists ? null : transaction.get(licenseRefs[index].collection("devices").limit(1)),
        ));
        let created = 0;
        let alreadyImported = 0;
        for (let index = 0; index < chunk.length; index += 1) {
          if (hashSnapshots[index].exists) { alreadyImported += 1; continue; }
          const entry = chunk[index];
          const licenseSnapshot = licenseSnapshots[index];
          if (!licenseSnapshot.exists) throw new HttpError(409, "A key was not found in the existing Firebase key generator. No key from this batch was imported.");
          const license = licenseSnapshot.data();
          if (license.active !== true) throw new HttpError(409, "Only active, unused Firebase keys can enter inventory.");
          if (license.activatedAt || license.expiresAt || !deviceSnapshots[index]?.empty) {
            throw new HttpError(409, "A key is already activated, assigned a fixed expiry, or registered on a device.");
          }
          if (license.activationMode && license.activationMode !== "firstSuccessfulRegistration") {
            throw new HttpError(409, "A key already has a different activation policy.");
          }
          if (license.validityMonths != null && license.validityMonths !== validityMonths) {
            throw new HttpError(409, "A key already has a different validity period.");
          }
          const plan = planSnapshot.data();
          if (license.membershipPlanId && license.membershipPlanId !== planId) throw new HttpError(409, "A key already belongs to a different membership plan.");
          if (license.portalLimit != null && license.portalLimit !== plan.portalLimit) throw new HttpError(409, "A key already has a different portal limit.");
          if (license.castIncluded != null && license.castIncluded !== Boolean(plan.castIncluded)) throw new HttpError(409, "A key already has different casting access.");
          const hashRef = db.collection(COLLECTIONS.keyHashes).doc(entry.digest);
          const inventoryRoot = db.collection(COLLECTIONS.inventory).doc(planId);
          const availableRef = inventoryRoot.collection("available").doc(entry.digest);
          transaction.update(licenseRefs[index], {
            validityMonths,
            activationMode: "firstSuccessfulRegistration",
            membershipPlanId: planId,
            membershipPlanName: plan.name,
            portalLimit: plan.portalLimit || 1,
            castIncluded: plan.castIncluded === true,
          });
          transaction.create(hashRef, { planId, status: "available", createdAt: serverTime() });
          transaction.create(availableRef, {
            encryptedKey: encryptKey(entry.key),
            keyTail: entry.key.slice(-4),
            createdAt: serverTime(),
          });
          created += 1;
        }
        return { created, alreadyImported };
      });
      imported += result.created;
      duplicates += result.alreadyImported;
    }
    return { imported, duplicates };
  });
}

export default modernHandler(handler);
