import { COLLECTIONS, modernHandler, runAdmin, safeDocument, serverTime } from "./lib/shared.js";

async function seedStarterPlans(db) {
  const setupRef = db.collection("stbWebSetup").doc("starter-plans-v1");
  const plansRef = db.collection(COLLECTIONS.plans);
  const starters = [
    {
      id: "starter-single-portal",
      name: "Single Portal",
      priceCents: 499,
      term: "year",
      summary: "For one portal on your STB PLAY app.",
      features: ["1 portal", "1-year membership", "Works across platforms"],
      portalLimit: 1,
      castIncluded: false,
      featured: false,
      active: true,
      sortOrder: 10,
    },
    {
      id: "starter-premium-monthly",
      name: "Premium Monthly",
      priceCents: 199,
      term: "month",
      summary: "Premium access with a monthly membership key.",
      features: ["Premium access", "Monthly membership", "Works across platforms"],
      portalLimit: 1,
      castIncluded: false,
      featured: true,
      active: true,
      sortOrder: 20,
    },
    {
      id: "starter-premium-yearly",
      name: "Premium Yearly",
      priceCents: 1999,
      term: "year",
      summary: "A year of premium access, including casting.",
      features: ["Premium access", "Cast option included", "1-year membership"],
      portalLimit: 1,
      castIncluded: true,
      featured: false,
      active: true,
      sortOrder: 30,
    },
  ];
  await db.runTransaction(async (transaction) => {
    const marker = await transaction.get(setupRef);
    if (marker.exists) return;
    const existingPlans = await transaction.get(plansRef.limit(1));
    if (existingPlans.empty) {
      for (const plan of starters) {
        transaction.create(plansRef.doc(plan.id), { ...plan, createdAt: serverTime(), updatedAt: serverTime() });
      }
    }
    transaction.create(setupRef, { starterPlansCheckedAt: serverTime() });
  });
}

async function handler(event) {
  return runAdmin(event, ["GET"], async ({ db }) => {
    await seedStarterPlans(db);
    const [plansSnapshot, releasesSnapshot, ordersSnapshot] = await Promise.all([
      db.collection(COLLECTIONS.plans).orderBy("sortOrder", "asc").get(),
      db.collection(COLLECTIONS.releases).orderBy("releaseDate", "desc").get(),
      db.collection(COLLECTIONS.orders).orderBy("createdAt", "desc").limit(20).get(),
    ]);
    const plans = plansSnapshot.docs.map(safeDocument);
    const releases = releasesSnapshot.docs.map(safeDocument);
    const inventoryCounts = {};
    await Promise.all(plans.map(async (plan) => {
      const stock = db.collection(COLLECTIONS.inventory).doc(plan.id);
      const [available, assigned] = await Promise.all([
        stock.collection("available").count().get(),
        stock.collection("assigned").count().get(),
      ]);
      inventoryCounts[plan.id] = { available: available.data().count, assigned: assigned.data().count };
    }));
    return { plans, releases, inventoryCounts, orders: ordersSnapshot.docs.map(safeDocument) };
  });
}

export default modernHandler(handler);
