import { COLLECTIONS, HttpError, decryptKey, headerValue, idempotencyDigest, modernHandler, runAdmin, serverTime } from "./lib/shared.js";

function safeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid buyer email address.");
  return email;
}

async function handler(event) {
  return runAdmin(event, ["POST"], async ({ db, user, body, headers }) => {
    const planId = String(body.planId || "").trim();
    if (!planId || planId.includes("/") || planId.length > 120) throw new HttpError(400, "Choose a valid membership plan.");
    const buyerEmail = safeEmail(body.buyerEmail);
    const idempotencyKey = headerValue(headers, "idempotency-key");
    if (!/^[a-zA-Z0-9-]{16,128}$/.test(idempotencyKey)) throw new HttpError(400, "A valid order request ID is required.");

    const orderId = idempotencyDigest(user.uid, idempotencyKey);
    const orderRef = db.collection(COLLECTIONS.orders).doc(orderId);
    const planRef = db.collection(COLLECTIONS.plans).doc(planId);
    const availableCollection = db.collection(COLLECTIONS.inventory).doc(planId).collection("available");
    const assignedCollection = db.collection(COLLECTIONS.inventory).doc(planId).collection("assigned");

    for (let searchRound = 0; searchRound < 8; searchRound += 1) {
      const candidates = await availableCollection.orderBy("createdAt", "asc").limit(20).get();
      if (candidates.empty) throw new HttpError(409, "There are no unused keys for this plan.");
      for (const candidate of candidates.docs) {
        const candidateRef = candidate.ref;
        const hashRef = db.collection(COLLECTIONS.keyHashes).doc(candidate.id);
        const result = await db.runTransaction(async (transaction) => {
          const existingOrder = await transaction.get(orderRef);
          if (existingOrder.exists) {
            const existing = existingOrder.data();
            if (existing.adminUid !== user.uid || existing.planId !== planId || existing.buyerEmail !== buyerEmail) {
              throw new HttpError(409, "This request ID was already used for a different sale.");
            }
            const existingKeyRef = assignedCollection.doc(existing.keyHash);
            const existingKey = await transaction.get(existingKeyRef);
            if (!existingKey.exists) throw new HttpError(500, "The assigned key could not be recovered.");
            return { key: existingKey.data().encryptedKey, order: existing, replay: true };
          }

          const [planSnapshot, stockSnapshot] = await transaction.getAll(planRef, candidateRef);
          if (!stockSnapshot.exists) return { unavailable: true };
          if (!planSnapshot.exists || planSnapshot.data().active === false) throw new HttpError(409, "This plan is unavailable for new sales.");

          const plan = planSnapshot.data();
          const assignedRef = assignedCollection.doc(candidate.id);
          const order = {
            planId,
            planName: plan.name,
            buyerEmail,
            adminUid: user.uid,
            keyHash: candidate.id,
            keyTail: stockSnapshot.data().keyTail || candidate.id.slice(-4),
            status: "assigned",
            createdAt: serverTime(),
          };
          transaction.delete(candidateRef);
          transaction.create(assignedRef, {
            ...stockSnapshot.data(),
            assignedAt: serverTime(),
            orderId,
            buyerEmail,
          });
          transaction.update(hashRef, { status: "assigned", assignedAt: serverTime(), orderId });
          transaction.create(orderRef, order);
          return { key: stockSnapshot.data().encryptedKey, order, replay: false };
        });

        if (result.unavailable) continue;
        return {
          key: decryptKey(result.key),
          replayed: result.replay,
          order: {
            planId: result.order.planId,
            planName: result.order.planName,
            buyerEmail: result.order.buyerEmail,
            keyTail: result.order.keyTail,
            status: result.order.status,
          },
        };
      }
    }
    throw new HttpError(409, "Available keys changed while assigning. Please retry the sale.");
  });
}

export default modernHandler(handler);
