import "./styles.css";

const platforms = [
  { id: "windows", name: "Windows", detail: "Desktop app", icon: "▣" },
  { id: "android", name: "Android", detail: "Phone & tablet", icon: "▯" },
  { id: "android-tv", name: "Android TV", detail: "TV & box", icon: "▱" },
  { id: "quest", name: "Meta Quest", detail: "Quest headset", icon: "◉" },
];

const starterPlans = [
  { id: "starter-single-portal", name: "Single Portal", priceCents: 499, term: "year", summary: "For one portal on your STB PLAY app.", features: ["1 portal", "1-year membership", "Works across platforms"], active: true, featured: false },
  { id: "starter-premium-monthly", name: "Premium Monthly", priceCents: 199, term: "month", summary: "Premium access with a monthly membership key.", features: ["Premium access", "Monthly membership", "Works across platforms"], active: true, featured: true },
  { id: "starter-premium-yearly", name: "Premium Yearly", priceCents: 1999, term: "year", summary: "A year of premium access, including casting.", features: ["Premium access", "Cast option included", "1-year membership"], active: true, featured: false },
];

const filters = ["All devices", ...platforms.map((platform) => platform.name)];
let activeFilter = "All devices";

function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function money(cents) {
  return new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(Number(cents || 0) / 100);
}

function renderFilters() {
  const target = document.querySelector("#platform-filter");
  target.innerHTML = filters.map((name) => `<button class="filter-chip ${name === activeFilter ? "active" : ""}" type="button" data-filter="${escapeHTML(name)}">${escapeHTML(name)}</button>`).join("");
  target.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    renderFilters();
    window.dispatchEvent(new CustomEvent("stb:catalog", { detail: window.__stbCatalog || {} }));
  }));
}

function renderReleases(releases = [], error = false) {
  const target = document.querySelector("#release-grid");
  if (error) {
    target.innerHTML = `<div class="empty-card">Release information is temporarily unavailable. Please refresh in a moment.</div>`;
    return;
  }
  const visiblePlatforms = platforms.filter((platform) => activeFilter === "All devices" || platform.name === activeFilter);
  const activeReleases = releases.filter((release) => release.active !== false);
  target.innerHTML = visiblePlatforms.map((platform) => {
    const release = activeReleases.filter((item) => item.platform === platform.id).sort((a, b) => String(b.releaseDate || "").localeCompare(String(a.releaseDate || "")))[0];
    if (!release) {
      return `<article class="release-card"><div class="release-top"><span class="platform-icon">${platform.icon}</span><span class="release-badge pending">COMING SOON</span></div><h3>${platform.name}</h3><div class="release-meta">${platform.detail}</div><p class="release-notes">No public build has been added for this platform yet.</p><button class="button button-ghost" type="button" disabled>Download coming soon</button></article>`;
    }
    const date = release.releaseDate ? ` · ${escapeHTML(release.releaseDate)}` : "";
    return `<article class="release-card"><div class="release-top"><span class="platform-icon">${platform.icon}</span><span class="release-badge">AVAILABLE</span></div><h3>${escapeHTML(release.title || platform.name)}</h3><div class="release-meta">Version ${escapeHTML(release.version || "—")}${date}</div><p class="release-notes">${escapeHTML(release.notes || platform.detail)}</p><a class="button button-primary" href="${escapeHTML(release.downloadUrl)}" target="_blank" rel="noopener noreferrer">Download <span aria-hidden="true">↓</span></a></article>`;
  }).join("");
}

function renderPlans(plans = starterPlans, error = false) {
  const target = document.querySelector("#plan-grid");
  if (error) {
    target.innerHTML = `<div class="empty-card">Membership options are temporarily unavailable. Please refresh in a moment.</div>`;
    return;
  }
  const activePlans = plans.filter((plan) => plan.active !== false);
  if (!activePlans.length) {
    target.innerHTML = `<div class="empty-card">Membership options will be listed here soon.</div>`;
    return;
  }
  target.innerHTML = activePlans.map((plan) => {
    const features = Array.isArray(plan.features) ? plan.features : [];
    const term = plan.term || "year";
    return `<article class="plan-card ${plan.featured ? "featured" : ""}">${plan.featured ? `<span class="plan-badge">PREMIUM</span>` : ""}<h3>${escapeHTML(plan.name)}</h3><p class="plan-summary">${escapeHTML(plan.summary || "STB PLAY membership key.")}</p><div class="price-row"><span class="price">${money(plan.priceCents)}</span><span class="term">CAD / ${escapeHTML(term)}</span></div><ul class="feature-list">${features.map((feature) => `<li>${escapeHTML(feature)}</li>`).join("")}</ul><button class="button button-ghost" type="button" disabled>Purchase key · coming soon</button></article>`;
  }).join("");
}

window.addEventListener("stb:catalog", (event) => {
  renderReleases(event.detail.releases || [], event.detail.error || false);
  renderPlans(event.detail.plans || starterPlans, event.detail.error || false);
});

async function loadCatalog() {
  renderFilters();
  window.__stbCatalog = { releases: [], plans: starterPlans };
  renderReleases([], false);
  renderPlans(starterPlans, false);
  try {
    const response = await fetch("/api/catalog", { headers: { accept: "application/json" }, cache: "no-store" });
    if (!response.ok) throw new Error(`Catalog returned ${response.status}`);
    const catalog = await response.json();
    window.__stbCatalog = { releases: Array.isArray(catalog.releases) ? catalog.releases : [], plans: Array.isArray(catalog.plans) ? catalog.plans : starterPlans };
    window.dispatchEvent(new CustomEvent("stb:catalog", { detail: window.__stbCatalog }));
  } catch {
    // Local previews without Netlify Functions keep editable-looking sample plans and empty builds.
    renderReleases([], false);
    renderPlans(starterPlans, false);
  }
}

loadCatalog();
