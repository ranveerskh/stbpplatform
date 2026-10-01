import "./styles.css";
import { onAuthStateChanged } from "firebase/auth";
import { firebaseAuth, firebaseReady, getAdminToken, signInAdmin, signOutAdmin } from "./firebase-client.js";

const authPanel = document.querySelector("#admin-auth");
const appPanel = document.querySelector("#admin-app");
const panel = document.querySelector("#admin-panel");
const tabs = [...document.querySelectorAll(".admin-tabs [data-tab]")];
let catalog = { plans: [], releases: [], inventoryCounts: {}, orders: [] };
let activeTab = "plans";
let editingPlanId = "";
let editingReleaseId = "";
let pendingKeys = [];
let currentUser = null;

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function money(cents) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(Number(cents || 0) / 100);
}

function setAuthMessage(message, isError = false) {
  const notice = document.querySelector("#auth-notice");
  if (!notice) return;
  notice.textContent = message;
  notice.className = `notice${isError ? " error" : ""}`;
}

async function api(endpoint, { method = "GET", body, idempotencyKey } = {}) {
  const token = await getAdminToken();
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const response = await fetch(`/api/admin/${endpoint}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function showLogin() {
  appPanel.hidden = true;
  authPanel.hidden = false;
  if (!firebaseReady) {
    authPanel.innerHTML = `<h2>Connect the Firebase web app</h2><p class="muted">Add the Firebase web app values to Netlify as <code>VITE_FIREBASE_API_KEY</code>, <code>VITE_FIREBASE_AUTH_DOMAIN</code>, <code>VITE_FIREBASE_PROJECT_ID</code>, and <code>VITE_FIREBASE_APP_ID</code>. Then redeploy this site.</p><div class="empty-state">The site uses the existing license project <b>stbpplay-platform</b>. No service-account secret belongs in GitHub or browser code.</div>`;
    return;
  }
  authPanel.innerHTML = `<h2>Sign in to manage STB PLAY</h2><p class="muted">Use the Google account already listed in Firebase <code>admins/{uid}</code>.</p><button class="button button-primary" id="google-signin" type="button">Continue with Google</button><div id="auth-notice" class="notice" role="status"></div>`;
  document.querySelector("#google-signin").addEventListener("click", async () => {
    try { await signInAdmin(); } catch (error) { setAuthMessage(error.message || "Google sign-in did not complete.", true); }
  });
}

async function loadAdminData() {
  const overview = await api("overview");
  catalog = {
    plans: Array.isArray(overview.plans) ? overview.plans : [],
    releases: Array.isArray(overview.releases) ? overview.releases : [],
    inventoryCounts: overview.inventoryCounts || {},
    orders: Array.isArray(overview.orders) ? overview.orders : [],
  };
  document.querySelector("#admin-user").textContent = `Signed in as ${currentUser?.email || currentUser?.displayName || "admin"}`;
  authPanel.hidden = true;
  appPanel.hidden = false;
  renderTab();
}

function showUnauthorized(error) {
  appPanel.hidden = true;
  authPanel.hidden = false;
  authPanel.innerHTML = `<h2>Admin access required</h2><p class="muted">${escapeHTML(error.message || "This account is not authorized to manage the site.")}</p><p class="muted">Ask the Firebase administrator to add your account to the existing <code>admins/{uid}</code> list.</p><button class="button button-ghost" id="signout-from-error" type="button">Sign out</button>`;
  document.querySelector("#signout-from-error")?.addEventListener("click", () => signOutAdmin());
}

function planOptions(selected = "") {
  if (!catalog.plans.length) return `<option value="">Add a plan first</option>`;
  return catalog.plans.map((plan) => `<option value="${escapeHTML(plan.id)}" ${plan.id === selected ? "selected" : ""}>${escapeHTML(plan.name)}${plan.active === false ? " · inactive" : ""}</option>`).join("");
}

function renderTab() {
  tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === activeTab));
  if (activeTab === "plans") renderPlansTab();
  else if (activeTab === "releases") renderReleasesTab();
  else if (activeTab === "keys") renderKeysTab();
  else renderOrdersTab();
}

function renderPlansTab() {
  panel.innerHTML = `<div class="admin-columns"><section><h2>${editingPlanId ? "Edit membership plan" : "Add membership plan"}</h2><p class="muted">Plans are displayed in CAD and shared across supported platforms.</p><form class="admin-form" id="plan-form">
    <label class="field-label">Plan name<input name="name" required maxlength="70" placeholder="Premium Yearly" /></label>
    <div class="admin-columns"><label class="field-label">Price (CAD)<input name="price" type="number" required min="0" step="0.01" placeholder="19.99" /></label><label class="field-label">Validity period<select name="term"><option value="month">Monthly</option><option value="year">Yearly</option><option value="lifetime">Lifetime</option></select></label></div>
    <label class="field-label">Short description<input name="summary" maxlength="150" placeholder="Premium access, including casting." /></label>
    <label class="field-label">Features, one per line<textarea name="features" placeholder="Premium access\nCast option included\n1-year membership"></textarea></label>
    <div class="admin-columns"><label class="field-label">Portal limit<input name="portalLimit" type="number" min="1" max="50" value="1" /></label><label class="field-label">Display order<input name="sortOrder" type="number" min="0" max="999" value="10" /></label></div>
    <label class="check-row"><input name="castIncluded" type="checkbox" /> Includes cast option</label><label class="check-row"><input name="featured" type="checkbox" /> Highlight this plan</label><label class="check-row"><input name="active" type="checkbox" checked /> Show on public page</label>
    <div class="flex-row"><button class="button button-primary" type="submit">${editingPlanId ? "Save changes" : "Add plan"}</button>${editingPlanId ? `<button class="button button-ghost" id="cancel-plan-edit" type="button">Cancel</button>` : ""}</div><div class="notice" id="plan-notice" role="status"></div></form></section>
    <section><h2>Membership plans</h2><p class="muted">${catalog.plans.length} plan${catalog.plans.length === 1 ? "" : "s"} saved.</p><div class="admin-list">${catalog.plans.length ? catalog.plans.map((plan) => { const count = catalog.inventoryCounts[plan.id] || {}; return `<article class="admin-record"><div class="admin-record-main"><b>${escapeHTML(plan.name)}</b><small>${money(plan.priceCents)} CAD / ${escapeHTML(plan.term || "year")} · ${Number(count.available || 0)} unused keys · ${plan.active === false ? "hidden" : "public"}</small></div><button data-edit-plan="${escapeHTML(plan.id)}" type="button">Edit</button><button class="danger" data-delete-plan="${escapeHTML(plan.id)}" type="button">Delete</button></article>`; }).join("") : `<div class="empty-state">No plans yet. Add the three starter values: $4.99 per year for one portal, $1.99 monthly Premium, and $19.99 yearly Premium with casting.</div>`}</div></section></div>`;
  const form = document.querySelector("#plan-form");
  const current = catalog.plans.find((plan) => plan.id === editingPlanId);
  if (current) {
    form.elements.name.value = current.name || "";
    form.elements.price.value = (Number(current.priceCents || 0) / 100).toFixed(2);
    form.elements.term.value = current.term || "year";
    form.elements.summary.value = current.summary || "";
    form.elements.features.value = Array.isArray(current.features) ? current.features.join("\n") : "";
    form.elements.portalLimit.value = current.portalLimit || 1;
    form.elements.sortOrder.value = current.sortOrder ?? 10;
    form.elements.castIncluded.checked = Boolean(current.castIncluded);
    form.elements.featured.checked = Boolean(current.featured);
    form.elements.active.checked = current.active !== false;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const payload = {
      name: String(data.get("name") || "").trim(),
      priceCents: Math.round(Number(data.get("price")) * 100),
      term: String(data.get("term") || "year"),
      summary: String(data.get("summary") || "").trim(),
      features: String(data.get("features") || "").split("\n").map((item) => item.trim()).filter(Boolean),
      portalLimit: Number(data.get("portalLimit") || 1),
      sortOrder: Number(data.get("sortOrder") || 0),
      castIncluded: form.elements.castIncluded.checked,
      featured: form.elements.featured.checked,
      active: form.elements.active.checked,
    };
    const notice = document.querySelector("#plan-notice");
    notice.textContent = "Saving…";
    try {
      await api(editingPlanId ? `plans?id=${encodeURIComponent(editingPlanId)}` : "plans", { method: editingPlanId ? "PUT" : "POST", body: payload });
      editingPlanId = "";
      await loadAdminData();
    } catch (error) { notice.textContent = error.message; notice.classList.add("error"); }
  });
  document.querySelector("#cancel-plan-edit")?.addEventListener("click", () => { editingPlanId = ""; renderPlansTab(); });
  panel.querySelectorAll("[data-edit-plan]").forEach((button) => button.addEventListener("click", () => { editingPlanId = button.dataset.editPlan; renderPlansTab(); }));
  panel.querySelectorAll("[data-delete-plan]").forEach((button) => button.addEventListener("click", async () => {
    if (!confirm("Delete this plan? Plans with imported keys or sales cannot be deleted; hide them instead.")) return;
    try { await api(`plans?id=${encodeURIComponent(button.dataset.deletePlan)}`, { method: "DELETE" }); await loadAdminData(); }
    catch (error) { alert(error.message); }
  }));
}

function renderReleasesTab() {
  const platformChoices = [["windows", "Windows"], ["android", "Android phone/tablet"], ["android-tv", "Android TV"], ["quest", "Meta Quest"]];
  panel.innerHTML = `<div class="admin-columns"><section><h2>${editingReleaseId ? "Edit release" : "Add a release"}</h2><p class="muted">Add a version and a direct download link. Public downloads only accept HTTPS links.</p><form class="admin-form" id="release-form">
    <label class="field-label">Platform<select name="platform">${platformChoices.map(([value,label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
    <div class="admin-columns"><label class="field-label">Version<input name="version" required maxlength="30" placeholder="1.8.20" /></label><label class="field-label">Release date<input name="releaseDate" type="date" /></label></div>
    <label class="field-label">Release title<input name="title" required maxlength="80" placeholder="STB PLAY for Windows" /></label><label class="field-label">Direct download URL<input name="downloadUrl" required type="url" placeholder="https://…" /></label>
    <label class="field-label">Release notes<textarea name="notes" maxlength="1000" placeholder="What changed in this version?"></textarea></label><label class="check-row"><input name="active" type="checkbox" checked /> Show on public page</label>
    <div class="flex-row"><button class="button button-primary" type="submit">${editingReleaseId ? "Save changes" : "Publish release"}</button>${editingReleaseId ? `<button class="button button-ghost" id="cancel-release-edit" type="button">Cancel</button>` : ""}</div><div class="notice" id="release-notice" role="status"></div></form></section>
    <section><h2>Published versions</h2><p class="muted">Each platform’s newest active version appears first.</p><div class="admin-list">${catalog.releases.length ? catalog.releases.map((release) => `<article class="admin-record"><div class="admin-record-main"><b>${escapeHTML(release.title || release.platform)}</b><small>${escapeHTML(release.version || "—")} · ${escapeHTML(release.platform || "")} · ${release.active === false ? "hidden" : "public"}</small></div><button data-edit-release="${escapeHTML(release.id)}" type="button">Edit</button><button class="danger" data-delete-release="${escapeHTML(release.id)}" type="button">Delete</button></article>`).join("") : `<div class="empty-state">No app files or download links are published yet. Add a release when you have its actual installer or APK URL.</div>`}</div></section></div>`;
  const form = document.querySelector("#release-form");
  const current = catalog.releases.find((release) => release.id === editingReleaseId);
  if (current) {
    form.elements.platform.value = current.platform || "windows";
    form.elements.version.value = current.version || "";
    form.elements.releaseDate.value = current.releaseDate || "";
    form.elements.title.value = current.title || "";
    form.elements.downloadUrl.value = current.downloadUrl || "";
    form.elements.notes.value = current.notes || "";
    form.elements.active.checked = current.active !== false;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const payload = { platform: data.get("platform"), version: String(data.get("version") || "").trim(), releaseDate: String(data.get("releaseDate") || ""), title: String(data.get("title") || "").trim(), downloadUrl: String(data.get("downloadUrl") || "").trim(), notes: String(data.get("notes") || "").trim(), active: form.elements.active.checked };
    const notice = document.querySelector("#release-notice");
    notice.textContent = "Saving…";
    try { await api(editingReleaseId ? `releases?id=${encodeURIComponent(editingReleaseId)}` : "releases", { method: editingReleaseId ? "PUT" : "POST", body: payload }); editingReleaseId = ""; await loadAdminData(); }
    catch (error) { notice.textContent = error.message; notice.classList.add("error"); }
  });
  document.querySelector("#cancel-release-edit")?.addEventListener("click", () => { editingReleaseId = ""; renderReleasesTab(); });
  panel.querySelectorAll("[data-edit-release]").forEach((button) => button.addEventListener("click", () => { editingReleaseId = button.dataset.editRelease; renderReleasesTab(); }));
  panel.querySelectorAll("[data-delete-release]").forEach((button) => button.addEventListener("click", async () => { if (!confirm("Delete this release link?")) return; try { await api(`releases?id=${encodeURIComponent(button.dataset.deleteRelease)}`, { method: "DELETE" }); await loadAdminData(); } catch (error) { alert(error.message); } }));
}

function renderKeysTab() {
  const countRows = catalog.plans.map((plan) => { const counts = catalog.inventoryCounts[plan.id] || {}; return `<div class="inventory-summary"><span>${escapeHTML(plan.name)}</span><small>${Number(counts.available || 0)} available · ${Number(counts.assigned || 0)} assigned</small></div>`; }).join("");
  panel.innerHTML = `<div class="admin-columns"><section><h2>Import generated keys</h2><p class="muted">Generate real keys with the existing Firebase key generator, then paste them one per line or upload a CSV. The import checks that each key is active and unused, then applies this plan’s first-use validity.</p><div class="admin-form"><label class="field-label">Membership plan<select id="key-plan">${planOptions()}</select></label><label class="field-label">Paste generated keys<textarea id="key-input" placeholder="STB-AB12-CD34-EF56\nSTB-…"></textarea></label><label class="field-label">Or load a CSV<input id="key-file" type="file" accept=".csv,text/csv" /></label><button class="button button-primary" id="import-keys" type="button">Import keys to inventory</button><div class="notice" id="key-notice" role="status"></div></div></section><section><h2>Key inventory</h2><p class="muted">Unused keys stay private here until you assign one after a sale.</p>${countRows || `<div class="empty-state">Add a membership plan before importing keys.</div>`}<div class="empty-state" style="margin-top:13px">The app starts the membership timer on the first successful registration. Existing activated, expired, or device-registered keys cannot be imported.</div></section></div>`;
  document.querySelector("#key-file").addEventListener("change", async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    const text = await file.text();
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    pendingKeys = lines.filter((line, index) => !(index === 0 && /^key\s*(,|$)/i.test(line))).map((line) => line.split(",")[0].replace(/^\s*"|"\s*$/g, "").trim()).filter(Boolean);
    document.querySelector("#key-input").value = pendingKeys.join("\n");
    document.querySelector("#key-notice").textContent = `${pendingKeys.length} key${pendingKeys.length === 1 ? "" : "s"} loaded from the file. Confirm the matching plan before import.`;
  });
  document.querySelector("#key-input").addEventListener("input", (event) => { pendingKeys = event.target.value.split(/\r?\n/).map((key) => key.trim()).filter(Boolean); });
  document.querySelector("#import-keys").addEventListener("click", async () => {
    const planId = document.querySelector("#key-plan").value;
    const notice = document.querySelector("#key-notice");
    if (!planId) { notice.textContent = "Add a plan first."; notice.classList.add("error"); return; }
    if (!pendingKeys.length) { notice.textContent = "Paste keys or choose a CSV file first."; notice.classList.add("error"); return; }
    if (pendingKeys.length > 100) { notice.textContent = "Import up to 100 keys at a time."; notice.classList.add("error"); return; }
    notice.classList.remove("error"); notice.textContent = "Importing…";
    try {
      const result = await api("keys-import", { method: "POST", body: { planId, keys: pendingKeys } });
      notice.textContent = `Imported ${result.imported || 0} new key${result.imported === 1 ? "" : "s"}; skipped ${result.duplicates || 0} duplicate${result.duplicates === 1 ? "" : "s"}.`;
      document.querySelector("#key-input").value = ""; document.querySelector("#key-file").value = ""; pendingKeys = [];
      await loadAdminData();
      activeTab = "keys"; renderKeysTab();
    } catch (error) { notice.textContent = error.message; notice.classList.add("error"); }
  });
}

function renderOrdersTab() {
  panel.innerHTML = `<div class="admin-columns"><section><h2>Reserve a key for a manual sale</h2><p class="muted">After confirming payment outside this site, reserve one unused key for the buyer. The key appears once for you to copy and send.</p><form class="admin-form" id="order-form"><label class="field-label">Plan<select name="planId" required>${planOptions()}</select></label><label class="field-label">Buyer email<input name="email" type="email" required maxlength="160" placeholder="buyer@example.com" /></label><button class="button button-primary" type="submit">Confirm sale & assign key</button><div class="notice" id="order-notice" role="status"></div><div id="assigned-key"></div></form><div class="empty-state" style="margin-top:14px">Online checkout is not connected. This button does not charge a customer; use it only after you confirm payment through your chosen method.</div></section><section><h2>Recent assignments</h2><div class="admin-list">${catalog.orders.length ? catalog.orders.map((order) => `<article class="admin-record"><div class="admin-record-main"><b>${escapeHTML(order.buyerEmail || "Buyer")}</b><small>${escapeHTML(order.planName || order.planId || "Plan")} · ${escapeHTML(order.status || "assigned")} · key ending ${escapeHTML(order.keyTail || "····")}</small></div><small>${escapeHTML(order.createdAt || "")}</small></article>`).join("") : `<div class="empty-state">No keys have been assigned from this site yet.</div>`}</div></section></div>`;
  let idempotencyKey = crypto.randomUUID();
  document.querySelector("#order-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const notice = document.querySelector("#order-notice");
    const data = new FormData(form);
    notice.classList.remove("error"); notice.textContent = "Assigning a key…";
    try {
      const result = await api("fulfill-manual-order", { method: "POST", body: { planId: data.get("planId"), buyerEmail: String(data.get("email") || "").trim() }, idempotencyKey });
      idempotencyKey = crypto.randomUUID();
      const assignedEmail = String(data.get("email") || "").trim();
      form.elements.email.value = "";
      try { await loadAdminData(); } catch { /* Keep the assigned key visible if refreshing the order list fails. */ }
      activeTab = "orders"; renderOrdersTab();
      const keyBox = document.querySelector("#assigned-key");
      keyBox.className = "result-key";
      keyBox.innerHTML = `<b>Key assigned. Send this code to the buyer:</b><code id="assigned-key-value">${escapeHTML(result.key)}</code><button class="mini-button" id="copy-key" type="button">Copy key</button>`;
      document.querySelector("#copy-key").addEventListener("click", async () => { await navigator.clipboard.writeText(result.key); document.querySelector("#copy-key").textContent = "Copied"; });
      document.querySelector("#order-notice").textContent = `Unused key assigned for ${assignedEmail}. Send the key above to the buyer.`;
    } catch (error) { notice.textContent = error.message; notice.classList.add("error"); }
  });
}

tabs.forEach((tab) => tab.addEventListener("click", () => { activeTab = tab.dataset.tab; editingPlanId = ""; editingReleaseId = ""; renderTab(); }));
document.querySelector("#signout-button").addEventListener("click", () => signOutAdmin());

if (!firebaseReady) {
  showLogin();
} else {
  authPanel.innerHTML = `<div class="loading-card">Checking signed-in account…</div>`;
  onAuthStateChanged(firebaseAuth, async (user) => {
    currentUser = user;
    if (!user) { showLogin(); return; }
    try { await loadAdminData(); }
    catch (error) { showUnauthorized(error); }
  });
}
