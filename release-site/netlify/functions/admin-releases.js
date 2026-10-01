import { COLLECTIONS, HttpError, modernHandler, parseRelease, runAdmin, safeDocument, serverTime } from "./lib/shared.js";

async function handler(event) {
  return runAdmin(event, ["GET", "POST", "PUT", "DELETE"], async ({ db, body, query }) => {
    const releases = db.collection(COLLECTIONS.releases);
    const id = String(query.id || "").trim();
    if (event.httpMethod === "GET") {
      const snapshot = await releases.orderBy("releaseDate", "desc").get();
      return { releases: snapshot.docs.map(safeDocument) };
    }
    if (event.httpMethod === "POST") {
      const release = parseRelease(body);
      release.createdAt = serverTime();
      const ref = await releases.add(release);
      return { id: ref.id };
    }
    if (!id || id.length > 120 || id.includes("/")) throw new HttpError(400, "A valid release ID is required.");
    const ref = releases.doc(id);
    const current = await ref.get();
    if (!current.exists) throw new HttpError(404, "Release not found.");
    if (event.httpMethod === "PUT") {
      await ref.set(parseRelease(body), { merge: true });
      return { id };
    }
    if (event.httpMethod === "DELETE") {
      await ref.delete();
      return { id, deleted: true };
    }
    throw new HttpError(405, "Method not allowed.");
  });
}

export default modernHandler(handler);
