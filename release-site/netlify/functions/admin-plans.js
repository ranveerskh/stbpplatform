import { COLLECTIONS, HttpError, modernHandler, parsePlan, runAdmin, safeDocument, serverTime } from "./lib/shared.js";

async function handler(event) {
  return runAdmin(event, ["GET", "POST", "PUT", "DELETE"], async ({ db, body, query }) => {
    const plans = db.collection(COLLECTIONS.plans);
    const id = String(query.id || "").trim();
    if (event.httpMethod === "GET") {
      const snapshot = await plans.orderBy("sortOrder", "asc").get();
      return { plans: snapshot.docs.map(safeDocument) };
    }
    if (event.httpMethod === "POST") {
      const plan = parsePlan(body);
      plan.createdAt = serverTime();
      const ref = await plans.add(plan);
      return { id: ref.id };
    }
    if (!id || id.length > 120 || id.includes("/")) throw new HttpError(400, "A valid plan ID is required.");
    const ref = plans.doc(id);
    const current = await ref.get();
    if (!current.exists) throw new HttpError(404, "Plan not found.");
    if (event.httpMethod === "PUT") {
      await ref.set(parsePlan(body), { merge: true });
      return { id };
    }
    if (event.httpMethod === "DELETE") {
      const inventory = db.collection(COLLECTIONS.inventory).doc(id);
      const salesQuery = db.collection(COLLECTIONS.orders).where("planId", "==", id).limit(1);
      await db.runTransaction(async (transaction) => {
        const [currentPlan, available, assigned, sales] = await Promise.all([
          transaction.get(ref),
          transaction.get(inventory.collection("available").limit(1)),
          transaction.get(inventory.collection("assigned").limit(1)),
          transaction.get(salesQuery),
        ]);
        if (!currentPlan.exists) throw new HttpError(404, "Plan not found.");
        if (!available.empty || !assigned.empty || !sales.empty) throw new HttpError(409, "This plan has imported keys or sales. Hide it instead of deleting it.");
        transaction.delete(ref);
      });
      return { id, deleted: true };
    }
    throw new HttpError(405, "Method not allowed.");
  });
}

export default modernHandler(handler);
