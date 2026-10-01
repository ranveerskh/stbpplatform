import { db, json, modernHandler, publicPlan, publicRelease } from "./lib/shared.js";

async function handler(event) {
  if (event.httpMethod !== "GET") return json(405, { error: "Method not allowed." });
  try {
    const firestore = db();
    const [plansSnapshot, releasesSnapshot] = await Promise.all([
      firestore.collection("stbWebPlans").where("active", "==", true).get(),
      firestore.collection("stbWebReleases").where("active", "==", true).get(),
    ]);
    const plans = plansSnapshot.docs.map((doc) => publicPlan({ id: doc.id, ...doc.data() }))
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    const releases = releasesSnapshot.docs.map((doc) => publicRelease({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(b.releaseDate || "").localeCompare(String(a.releaseDate || "")));
    return json(200, { plans, releases });
  } catch {
    return json(503, { error: "Catalog is temporarily unavailable." });
  }
}

export default modernHandler(handler);
