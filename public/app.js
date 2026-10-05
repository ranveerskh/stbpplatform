import { auth, functions } from './firebase-config.js';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';

const $ = id => document.getElementById(id);
const listDashboard = httpsCallable(functions, 'adminListDashboard');
const createKey = httpsCallable(functions, 'adminCreateKey');
const setKeyStatus = httpsCallable(functions, 'adminSetKeyStatus');
const archiveKey = httpsCallable(functions, 'adminArchiveKey');
const archiveAccount = httpsCallable(functions, 'partnerArchiveAccount');
const archiveCustomer = httpsCallable(functions, 'partnerArchiveCustomer');
const previewDeletion = httpsCallable(functions, 'adminPreviewDeletion');
const deleteRecord = httpsCallable(functions, 'adminDeleteRecord');
const setVersionRules = httpsCallable(functions, 'adminSetVersionRules');
const listPartnerDashboard = httpsCallable(functions, 'partnerListDashboard');
const loadAdminCreditSummary = httpsCallable(functions, 'adminCreditSummary');
const createDistributor = httpsCallable(functions, 'adminCreateDistributor');
const createPartnerChild = httpsCallable(functions, 'partnerCreateChild');
const transferCredits = httpsCallable(functions, 'partnerTransferCredits');
const changePartnerRole = httpsCallable(functions, 'partnerSetAccountRole');
const savePartnerLimits = httpsCallable(functions, 'adminSetPartnerLimits');
const providerDashboard = httpsCallable(functions, 'partnerProviderDashboard');
const createPortalProfile = httpsCallable(functions, 'partnerCreatePortalProfile');
const updatePortalProfile = httpsCallable(functions, 'partnerUpdatePortalProfile');
const completePairing = httpsCallable(functions, 'partnerCompletePairing');
const renewDeviceLicense = httpsCallable(functions, 'partnerRenewDeviceLicense');
const switchDevicePortal = httpsCallable(functions, 'partnerSwitchDevicePortal');
const adminProviderDashboard = httpsCallable(functions, 'adminProviderDashboard');
const adminListPairingProfiles = httpsCallable(functions, 'adminListPairingProfiles');
const adjustPartnerCredits = httpsCallable(functions, 'adminAdjustPartnerCredits');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const setVisible = (id, visible) => $(id).classList.toggle('hidden', !visible);
function friendlyError(error) { return error?.message?.replace(/^Firebase:\s*/,'') || 'Something went wrong. Please retry.'; }
let activeAdminTab = 'overview';
let currentPartnerData = null;
let currentPartnerActor = null;
let transferTarget = null;
let editingProfile = null;
let adminPairingProfiles = [];
let adminKeys = [];
let showAllAdminKeys = false;
let showArchivedKeys = false;
let showArchivedAccounts = false;
let showArchivedAdminCustomers = false;
let showArchivedPartnerCustomers = false;
let showArchivedPartnerLicenses = false;
let partnerLicenses = [];
let showAllPartnerLicenses = false;
let pendingDeletion = null;
const licenseStatusLabel = { active: 'Active', trial: '7-day trial', grace: 'Grace period', expired: 'Expired', disabled: 'Disabled' };
const licenseYearOptions = (selected = 1) => Array.from({ length: 10 }, (_, index) => index + 1)
  .map(years => `<option value="${years}" ${years === selected ? 'selected' : ''}>${years} year${years === 1 ? '' : 's'} · ${years} credit${years === 1 ? '' : 's'}</option>`).join('');
function formatDateTime(value) { return value ? new Date(value).toLocaleString() : 'Not set'; }
function localDateTimeValue(value) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function openDialog(id) { $(id).showModal(); }
function closeDialog(id) { $(id).close(); }
async function reviewDeletion(kind, targetId) {
  showDeletionReview((await previewDeletion({ kind, targetId })).data);
}
function showDeletionReview(item) {
  pendingDeletion = item;
  $('deleteForm').reset();
  $('deleteForm').querySelector('[type="submit"]').textContent = 'Delete permanently';
  $('deleteError').textContent = '';
  $('deleteTitle').textContent = `Delete ${item.label}?`;
  $('deleteSummary').textContent = item.alreadyDeleted
    ? 'The records were deleted. Confirm to retry any remaining sign-in cleanup.'
    : `${item.accounts} partner account(s), ${item.customers} customer(s), and ${item.profiles} portal profile(s) will be permanently removed. Customer licenses and sign-in access will be removed. ${item.credits} unused credits will return to ${item.creditsReturnedTo}. Paid license credits stay spent. Ledger and audit history are kept.`;
  openDialog('deleteDialog');
}
function customerPortalControl(customer, profiles) {
  const choices = profiles.filter(profile => profile.active && (!profile.ownerUid || profile.ownerUid === customer.ownerUid));
  return `<div class="devicePortalControl" data-current-profile="${escapeHtml(customer.portalProfileId)}"><select data-device-profile aria-label="Active portal for ${escapeHtml(customer.customerLabel)}" ${choices.length ? '' : 'disabled'}><option value="">${choices.length ? 'Choose active portal' : 'No active profiles for this account'}</option>${choices.map(profile => `<option value="${escapeHtml(profile.id)}" ${profile.id === customer.portalProfileId ? 'selected' : ''}>${escapeHtml(profile.name)} · ${escapeHtml(profile.host)}</option>`).join('')}</select><button type="button" class="textButton" data-switch-portal="${escapeHtml(customer.deviceRef)}" disabled>Switch portal</button><small>Current: ${escapeHtml(customer.portalName)}${customer.portalActive ? '' : ' · inactive'}</small><small data-portal-message role="status" aria-live="polite"></small></div>`;
}
function bindPortalChoices(container) {
  container.onchange = event => {
    if (!event.target.matches('[data-device-profile]')) return;
    const control = event.target.closest('.devicePortalControl');
    control.querySelector('[data-switch-portal]').disabled = !event.target.value || event.target.value === control.dataset.currentProfile;
    control.querySelector('[data-portal-message]').textContent = '';
  };
}
async function applyCustomerPortal(button, refresh, messageId) {
  const control = button.closest('.devicePortalControl');
  const select = control.querySelector('[data-device-profile]');
  const profileId = select.value;
  if (!profileId || profileId === control.dataset.currentProfile) return;
  const message = control.querySelector('[data-portal-message]');
  button.disabled = select.disabled = true;
  message.textContent = 'Switching portal…';
  try {
    await switchDevicePortal({ deviceRef: button.dataset.switchPortal, profileId });
    control.dataset.currentProfile = profileId;
    message.textContent = 'Portal saved. The app receives it on its next sync.';
    try { await refresh(); $(messageId).textContent = 'Customer portal updated. The app receives it on its next sync.'; }
    catch { $(messageId).textContent = 'Portal saved. Refresh the customer list to see the change.'; }
  } catch (error) {
    message.textContent = friendlyError(error);
    $(messageId).textContent = friendlyError(error);
  } finally {
    select.disabled = false;
    button.disabled = select.value === control.dataset.currentProfile;
  }
}
function renderAdminKeys() {
  const matching = adminKeys.filter(key => (key.archived === true) === showArchivedKeys);
  const rows = showAllAdminKeys ? matching : matching.slice(0, 10);
  $('keyListCount').textContent = matching.length ? `Showing ${rows.length} of ${matching.length}${adminKeys.length === 250 ? ' latest loaded' : ''} ${showArchivedKeys ? 'archived ' : ''}keys` : `No ${showArchivedKeys ? 'archived ' : ''}keys`;
  $('showMoreKeys').textContent = showAllAdminKeys ? 'Show fewer' : 'Show more';
  setVisible('showMoreKeys', matching.length > 10);
  $('toggleArchivedKeys').textContent = showArchivedKeys ? `Show active keys (${adminKeys.filter(key => !key.archived).length})` : `Show archived keys (${adminKeys.filter(key => key.archived).length})`;
  setVisible('toggleArchivedKeys', adminKeys.some(key => key.archived));
  const state = k => k.archived ? 'Archived' : k.expired ? 'Expired' : k.active ? 'Active' : 'Disabled';
  const stateClass = k => !k.archived && !k.expired && k.active ? 'on' : 'off';
  const keyActions = k => `<button type="button" class="textButton keyStatusAction" data-key="${escapeHtml(k.id)}" data-active="${k.active}" ${k.archived ? 'disabled' : ''}>${k.active ? 'Disable key' : 'Enable key'}</button>${k.ownerUid ? '<small class="muted">Customer licenses are managed from Customers.</small>' : `<button type="button" class="textButton keyArchiveAction" data-key-archive="${escapeHtml(k.id)}" data-archived="${k.archived === true}" ${!k.archived && k.deviceCount > 0 ? 'disabled title="Key has device assignments"' : ''}>${k.archived ? 'Restore key' : 'Archive key'}</button>`}`;
  const creatorDetails = k => `<details class="accountDetails keyDetails"><summary>Key details, creator & actions</summary><div class="detailGrid"><span>Created by</span><b>${escapeHtml(k.createdByName || (k.createdBy ? 'Admin (name unavailable)' : 'Unknown legacy creator'))}</b><span>Role</span><b>${escapeHtml(k.createdByRole || '—')}</b><span>Email</span><b>${escapeHtml(k.createdByEmail || '—')}</b><span>Account ID</span><code>${escapeHtml(k.createdBy || '—')}</code><span>Created</span><b>${escapeHtml(formatDateTime(k.createdAt))}</b><span>Device assignments</span><b>${k.deviceCount} / ${k.deviceLimit}</b><span>Expiry</span><b>${escapeHtml(k.expiresAt ? new Date(k.expiresAt).toLocaleString() : 'Never')}</b><span>State</span><b>${state(k)}</b></div>${keyActions(k)}</details>`;
  $('keysBody').innerHTML = rows.map(k => `<tr><td><b>${escapeHtml(k.label || '—')}</b><br><small>•••• ${escapeHtml(k.keyHint || '—')}</small>${creatorDetails(k)}</td><td>${k.deviceCount} / ${k.deviceLimit}</td><td>${k.expiresAt ? new Date(k.expiresAt).toLocaleString() : 'Never'}</td><td><span class="tag ${stateClass(k)}">${state(k)}</span></td></tr>`).join('') || `<tr><td colspan="4">No ${showArchivedKeys ? 'archived ' : ''}keys</td></tr>`;
  $('keyCards').innerHTML = rows.map(k => `<article class="keyCard customerCard"><div class="customerCardHead"><div><b>${escapeHtml(k.label || '—')}</b><small>•••• ${escapeHtml(k.keyHint || '—')}</small></div><span class="tag ${stateClass(k)}">${state(k)}</span></div>${creatorDetails(k)}</article>`).join('') || `<p class="muted">No ${showArchivedKeys ? 'archived ' : ''}keys.</p>`;
  document.querySelectorAll('#keysBody [data-key], #keyCards [data-key]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await setKeyStatus({ keyId:button.dataset.key, active:button.dataset.active !== 'true' }); await refreshDashboard(); }
    catch(error) { alert(friendlyError(error)); button.disabled = false; }
  }));
  document.querySelectorAll('#keysBody [data-key-archive], #keyCards [data-key-archive]').forEach(button => button.addEventListener('click', async () => {
    const archived = button.dataset.archived !== 'true';
    if (!confirm(`${archived ? 'Archive' : 'Restore'} this key? ${archived ? 'It will leave the active list; key and creator history will be kept.' : 'It will return to the active keys list.'}`)) return;
    button.disabled = true;
    try { await archiveKey({ keyId:button.dataset.keyArchive, archived }); await refreshDashboard(); }
    catch(error) { alert(friendlyError(error)); button.disabled = false; }
  }));
}
function renderPartnerLicenses() {
  const matching = partnerLicenses.filter(item => (item.archived === true) === showArchivedPartnerLicenses);
  const rows = showAllPartnerLicenses ? matching : matching.slice(0, 10);
  $('partnerLicenseCount').textContent = matching.length ? `Showing ${rows.length} of ${matching.length}${partnerLicenses.length === 500 ? ' latest loaded' : ''} ${showArchivedPartnerLicenses ? 'archived ' : ''}licenses` : `No ${showArchivedPartnerLicenses ? 'archived ' : ''}licenses`;
  $('showMorePartnerLicenses').textContent = showAllPartnerLicenses ? 'Show fewer' : 'Show more';
  setVisible('showMorePartnerLicenses', matching.length > 10);
  $('toggleArchivedPartnerLicenses').textContent = showArchivedPartnerLicenses ? `Show active licenses (${partnerLicenses.filter(item => !item.archived).length})` : `Show archived licenses (${partnerLicenses.filter(item => item.archived).length})`;
  setVisible('toggleArchivedPartnerLicenses', partnerLicenses.some(item => item.archived));
  const licenseLabel = customer => customer.archived ? 'Archived' : licenseStatusLabel[customer.licenseState] || 'Unknown';
  $('partnerKeysBody').innerHTML = rows.map(customer => `<tr><td>${escapeHtml(customer.customerLabel)}</td><td>${customer.keyHint ? `•••• ${escapeHtml(customer.keyHint)}` : 'Legacy license'}</td><td>${escapeHtml(customer.createdByName || '—')}</td><td>${customer.trial ? '7-day trial' : `${customer.durationYears} year${customer.durationYears === 1 ? '' : 's'}`}</td><td><span class="tag ${customer.archived ? 'off' : ['active','trial'].includes(customer.licenseState) ? 'on' : 'off'}">${escapeHtml(licenseLabel(customer))}</span></td><td>${escapeHtml(formatDate(customer.trialExpiresAt || customer.licenseExpiresAt))}</td></tr>`).join('') || `<tr><td colspan="6">No ${showArchivedPartnerLicenses ? 'archived ' : ''}customer licenses created by this account.</td></tr>`;
  $('partnerKeysCards').innerHTML = rows.map(customer => `<article class="customerCard compactLicenseCard"><div class="customerCardHead"><b>${escapeHtml(customer.customerLabel)}</b><span class="tag ${customer.archived ? 'off' : customer.licenseState === 'active' ? 'on' : 'off'}">${escapeHtml(licenseLabel(customer))}</span></div><p class="muted">${customer.keyHint ? `•••• ${escapeHtml(customer.keyHint)} · ` : ''}${customer.durationYears} year${customer.durationYears === 1 ? '' : 's'} · expires ${escapeHtml(formatDate(customer.licenseExpiresAt))}</p><details class="accountDetails"><summary>License details</summary><p>Created by ${escapeHtml(customer.createdByName || '—')}</p></details></article>`).join('') || `<p class="muted">No ${showArchivedPartnerLicenses ? 'archived ' : ''}customer licenses created by this account.</p>`;
}
function showAdminTab(tab) {
  const role = currentPartnerActor?.role || 'admin';
  const isAdmin = role === 'admin';
  const views = isAdmin ? {
    overview: ['adminCreditOverview'], keys: ['keysPanel'],
    partners: ['partnerPanel', 'partnerLimitsPanel'], customers: ['adminCustomersPanel'], usage: ['adminUsagePanel', 'statsPanel', 'devicesPanel']
  } : {
    overview: ['partnerOverviewPanel'], keys: ['partnerKeysPanel'],
    partners: role === 'provider' ? [] : ['partnerPanel'], customers: ['providerPanel'], settings: ['partnerSettingsPanel']
  };
  if (!views[tab]) tab = 'overview';
  activeAdminTab = tab;
  for (const id of ['adminCreditOverview','adminUsagePanel','statsPanel','devicesPanel','keysPanel','partnerPanel','partnerLimitsPanel','adminCustomersPanel','partnerOverviewPanel','partnerKeysPanel','providerPanel','partnerSettingsPanel']) {
    setVisible(id, views[tab].includes(id));
  }
  document.querySelector('[data-admin-tab="partners"]').classList.toggle('hidden', !isAdmin && role === 'provider');
  document.querySelector('[data-admin-tab="settings"]').classList.toggle('hidden', isAdmin);
  document.querySelector('[data-admin-tab="usage"]').classList.toggle('hidden', !isAdmin);
  setVisible('providerError', !isAdmin);
  document.querySelector('[data-admin-tab="keys"]').textContent = isAdmin ? 'Keys' : 'My licenses';
  document.querySelectorAll('[data-admin-tab]').forEach(button => {
    const selected = button.dataset.adminTab === tab;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-current', selected ? 'page' : 'false');
  });
}
document.querySelectorAll('[data-admin-tab]').forEach(button => button.addEventListener('click', () => {
  showAdminTab(button.dataset.adminTab);
  if (activeAdminTab === 'customers' && currentPartnerActor?.role === 'admin') loadAdminCustomers();
  else if (activeAdminTab === 'customers') refreshProviderDashboard().catch(error => $('providerError').textContent = friendlyError(error));
  else if (activeAdminTab === 'settings') refreshProviderDashboard().catch(error => $('providerError').textContent = friendlyError(error));
}));

async function refreshDashboard() {
  $('dashboardError').textContent = '';
  const partnerData = (await listPartnerDashboard()).data;
  const actor = partnerData.account;
  currentPartnerData = partnerData;
  currentPartnerActor = actor;
  $('accountHeading').textContent = actor.role === 'admin' ? 'All partner accounts' : 'Your accounts';
  $('accountSummary').textContent = `${actor.displayName || actor.email || actor.role} · ${actor.role} · ${actor.credits ?? 0} credits`;
  $('deletionRetryList').innerHTML = actor.role === 'admin' ? (partnerData.pendingDeletions || []).map((item, index) =>
    `<p class="note">Sign-in cleanup pending: ${escapeHtml(item.label)} <button type="button" class="textButton" data-retry-deletion="${index}">Retry cleanup</button></p>`).join('') : '';
  $('deletionRetryList').onclick = event => {
    const button = event.target.closest('[data-retry-deletion]');
    const item = button && partnerData.pendingDeletions?.[Number(button.dataset.retryDeletion)];
    if (actor.role === 'admin' && item) showDeletionReview({ ...item, alreadyDeleted: true });
  };
  const canCreate = ['admin','distributor','reseller'].includes(actor.role);
  $('createPartner').classList.toggle('hidden', !canCreate);
  $('createPartner').textContent = actor.role === 'admin' ? 'Create distributor' : actor.role === 'distributor' ? 'Create reseller' : 'Create provider';
  $('adminTools').classList.toggle('hidden', actor.role !== 'admin');
  setVisible('adminNav', true);
  setVisible('partnerPanel', actor.role !== 'provider');
  setVisible('providerPanel', actor.role !== 'admin');
  showAdminTab(activeAdminTab);
  if (actor.role !== 'admin') await refreshProviderDashboard();
  if (actor.role === 'admin' && partnerData.limits) {
    for (const id of ['distributorMinCredits','distributorToResellerMax','resellerToProviderMin']) $(id).value = partnerData.limits[id];
  }
  const allAccounts = partnerData.accounts;
  const displayedAccounts = allAccounts.filter(item => (item.archived === true) === showArchivedAccounts);
  $('toggleArchivedAccounts').textContent = showArchivedAccounts ? `Show active accounts (${allAccounts.filter(item => !item.archived).length})` : `Show archived accounts (${allAccounts.filter(item => item.archived).length})`;
  setVisible('toggleArchivedAccounts', allAccounts.some(item => item.archived));
  const roleChoices = actor.role === 'admin' ? ['distributor','reseller','provider'] : ['reseller','provider'];
  const parentChoices = (role, excludeUid = '') => {
    if (role === 'distributor') return [{ uid:'', displayName:'Admin', role:'admin' }];
    const required = role === 'reseller' ? 'distributor' : 'reseller';
    const candidates = allAccounts.filter(item => item.uid !== excludeUid && item.active && item.role === required && (actor.role === 'admin' || item.parentUid === actor.uid || item.uid === actor.uid));
    if (actor.role === required && !candidates.some(item => item.uid === actor.uid)) candidates.unshift({ uid:actor.uid, displayName:actor.displayName || actor.email, role:actor.role });
    return candidates;
  };
  const requiredParentRole = role => ({ distributor:'admin', reseller:'distributor', provider:'reseller' })[role];
  const requiredChildRole = role => ({ distributor:'reseller', reseller:'provider', provider:null })[role];
  const roleChangeReason = (account, role, selectedParentUid) => {
    const children = allAccounts.filter(item => item.parentUid === account.uid);
    const allowedChild = requiredChildRole(role);
    const incompatible = children.filter(item => allowedChild ? item.role !== allowedChild : true);
    if (incompatible.length) {
      const names = incompatible.slice(0, 3).map(item => item.displayName || item.email).join(', ');
      return allowedChild
        ? `Move these child accounts first; a ${role} can have only ${allowedChild} children: ${names}.`
        : `Move these child accounts first; a Provider cannot have children: ${names}.`;
    }
    if (role === 'distributor') return '';
    const expectedParent = requiredParentRole(role), candidates = parentChoices(role, account.uid);
    if (!candidates.length) return `No active ${expectedParent} parent is available in your ${actor.role === 'distributor' ? 'branch' : 'partner list'}.`;
    if (!selectedParentUid) return `Choose an active ${expectedParent} parent before saving this role.`;
    if (!candidates.some(item => item.uid === selectedParentUid)) return `Choose an active ${expectedParent} parent in your permitted branch.`;
    return '';
  };
  const roleOptions = account => roleChoices.map(role => {
    const blockedChildren = allAccounts.filter(item => item.parentUid === account.uid && (requiredChildRole(role) ? item.role !== requiredChildRole(role) : true));
    const noParent = role !== 'distributor' && !parentChoices(role, account.uid).length;
    const hint = blockedChildren.length ? ' · move child accounts first' : noParent ? ` · no ${requiredParentRole(role)} available` : '';
    return `<option value="${role}" ${role === account.role ? 'selected' : ''}>${role}${hint}</option>`;
  }).join('');
  const parentOptions = account => {
    if (account.role === 'distributor') return '<option value="">Admin</option>';
    const candidates = parentChoices(account.role, account.uid), currentParentExists = candidates.some(parent => parent.uid === account.parentUid);
    return `<option value="" disabled ${currentParentExists ? '' : 'selected'}>Choose ${requiredParentRole(account.role)} parent</option>${candidates.map(parent => `<option value="${escapeHtml(parent.uid)}" ${parent.uid === account.parentUid ? 'selected' : ''}>${escapeHtml(parent.displayName)} · ${parent.role}</option>`).join('')}`;
  };
  const canRoleChange = account => (actor.role === 'admin' && roleChoices.includes(account.role)) || (actor.role === 'distributor' && account.role !== 'distributor');
  const syncRoleEditor = (row, account) => {
    const role = row.querySelector(`[data-role-for="${CSS.escape(account.uid)}"]`);
    const parent = row.querySelector(`[data-parent-for="${CSS.escape(account.uid)}"]`);
    const help = row.querySelector(`[data-role-help="${CSS.escape(account.uid)}"]`);
    const save = row.querySelector(`[data-partner-action="role"][data-uid="${CSS.escape(account.uid)}"]`);
    if (!role || !parent || !help || !save) return;
    const selectedParentUid = role.value === 'distributor' ? null : (parent.value || null);
    const reason = roleChangeReason(account, role.value, selectedParentUid);
    const unchanged = role.value === account.role && selectedParentUid === (account.parentUid || null);
    help.textContent = reason || (unchanged ? '' : `Ready to save ${role.value} under ${role.value === 'distributor' ? 'Admin' : parent.selectedOptions[0]?.textContent || 'the selected parent'}.`);
    help.classList.toggle('hidden', !reason && unchanged);
    help.classList.toggle('error', !!reason);
    save.disabled = !!reason || unchanged;
  };
  const manage = account => {
    const canArchive = actor.role === 'admin' || (account.parentUid === actor.uid && ((actor.role === 'distributor' && account.role === 'reseller') || (actor.role === 'reseller' && account.role === 'provider')));
    const deleteAction = actor.role === 'admin' ? `<button type="button" class="textButton dangerAction" data-partner-action="delete" data-uid="${escapeHtml(account.uid)}">Delete account</button>` : '';
    if (account.archived) return canArchive ? `<div class="accountActions"><button class="textButton" data-partner-action="archive" data-uid="${escapeHtml(account.uid)}" data-archived="true">Restore account</button>${deleteAction}</div>` : '';
    const canTransfer = (actor.role === 'distributor' && account.role === 'reseller') || (actor.role === 'reseller' && account.role === 'provider');
    return `<div class="accountActions">${canTransfer ? `<button class="textButton" data-partner-action="transfer" data-uid="${escapeHtml(account.uid)}">Transfer credits</button>` : ''}${actor.role === 'admin' ? `<button class="textButton" data-partner-action="adjust" data-uid="${escapeHtml(account.uid)}">Adjust credits</button>` : ''}${canRoleChange(account) ? `<details class="roleEditor"><summary>Change role</summary><label>Role<select data-role-for="${escapeHtml(account.uid)}">${roleOptions(account)}</select></label><label>Parent<select data-parent-for="${escapeHtml(account.uid)}" ${account.role === 'distributor' ? 'disabled' : ''}>${parentOptions(account)}</select></label><p class="note roleHelp hidden" data-role-help="${escapeHtml(account.uid)}"></p><button class="ghost small" data-partner-action="role" data-uid="${escapeHtml(account.uid)}">Save role</button></details>` : ''}${canArchive ? `<button class="textButton" data-partner-action="archive" data-uid="${escapeHtml(account.uid)}" data-archived="false">Archive account</button>` : ''}${deleteAction}</div>`;
  };
  const details = account => {
    const events = (partnerData.recentActivity || []).filter(item => item.fromUid === account.uid || item.toUid === account.uid || item.actorUid === account.uid).slice(0, 8);
    const activity = events.map(item => `<li>${escapeHtml(activityLabel(item.type))}${item.durationYears ? ` · ${item.durationYears} year${item.durationYears === 1 ? '' : 's'}` : ''} · ${item.amount} credit${item.amount === 1 ? '' : 's'} · ${escapeHtml(item.fromName)} → ${escapeHtml(item.toName)} <small>${escapeHtml(formatDateTime(item.createdAt))}</small></li>`).join('') || '<li>No recent account activity.</li>';
    return `<details class="accountDetails"><summary>Account details & activity</summary><div class="detailGrid"><span>Email</span><b>${escapeHtml(account.email || '—')}</b><span>Parent</span><b>${escapeHtml(account.parentName || 'Admin')}${account.parentUid ? ` · ${escapeHtml(account.parentUid)}` : ''}</b><span>Created by</span><b>${escapeHtml(account.createdByName || '—')}</b><span>Creator role</span><b>${escapeHtml(account.createdByRole || '—')}</b><span>Creator email</span><b>${escapeHtml(account.createdByEmail || '—')}</b><span>Creator ID</span><code>${escapeHtml(account.createdByUid || '—')}</code><span>Created</span><b>${escapeHtml(formatDateTime(account.createdAt))}</b><span>Account ID</span><code>${escapeHtml(account.uid)}</code></div><ul class="activityList">${activity}</ul></details>`;
  };
  const recentEvents = partnerData.recentActivity || [];
  $('partnerOverviewActivity').innerHTML = recentEvents.map(item => `<li>${escapeHtml(activityLabel(item.type))}${item.durationYears ? ` · ${item.durationYears} year${item.durationYears === 1 ? '' : 's'}` : ''} · ${item.amount} credit${item.amount === 1 ? '' : 's'} · ${escapeHtml(item.fromName)} → ${escapeHtml(item.toName)} · by ${escapeHtml(item.actorName)} <small>${escapeHtml(formatDateTime(item.createdAt))}</small></li>`).join('');
  setVisible('partnerOverviewActivityEmpty', recentEvents.length === 0);
  $('partnerOverviewActivity').classList.toggle('hidden', recentEvents.length === 0);
  $('accountsBody').innerHTML = displayedAccounts.map(a => `<tr><td><b>${escapeHtml(a.displayName)}</b><br><small>${escapeHtml(a.email)}</small></td><td>${escapeHtml(a.role)}</td><td>${escapeHtml(a.parentName || 'Admin')}</td><td>${a.credits}</td><td><span class="tag ${a.archived?'off':a.active?'on':'off'}">${a.archived?'Archived':a.active?'Active':'Disabled'}</span></td><td>${manage(a)}${details(a)}</td></tr>`).join('') || `<tr><td colspan="6">No ${showArchivedAccounts ? 'archived ' : ''}accounts to show</td></tr>`;
  $('accountsCards').innerHTML = displayedAccounts.map(a => `<article class="accountCard"><div class="accountCardHead"><div><b>${escapeHtml(a.displayName)}</b><small>${escapeHtml(a.role)} · under ${escapeHtml(a.parentName || 'Admin')}</small></div><strong>${a.credits} <small>credits</small></strong></div><div class="accountCardStatus"><span class="tag ${a.archived?'off':a.active?'on':'off'}">${a.archived?'Archived':a.active?'Active':'Disabled'}</span></div>${details(a)}<details class="accountDetails"><summary>${a.archived ? 'Restore account' : 'Manage account'}</summary>${manage(a)}</details></article>`).join('') || `<p class="muted">No ${showArchivedAccounts ? 'archived ' : ''}accounts to show.</p>`;
  document.querySelectorAll('#accountsBody tr, #accountsCards .accountCard').forEach(row => {
    const role = row.querySelector('[data-role-for]');
    const account = role && allAccounts.find(item => item.uid === role.dataset.roleFor);
    if (account) syncRoleEditor(row, account);
  });
  $('accountsBody').onclick = $('accountsCards').onclick = async event => {
    const button = event.target.closest('[data-partner-action]'); if (!button) return;
    const account = partnerData.accounts.find(a => a.uid === button.dataset.uid); if (!account) return;
    try {
      if (button.dataset.partnerAction === 'delete' && actor.role === 'admin') {
        button.disabled = true;
        try { await reviewDeletion('account', account.uid); } finally { button.disabled = false; }
        return;
      } else if (button.dataset.partnerAction === 'archive') {
        const archived = button.dataset.archived !== 'true';
        if (!confirm(`${archived ? 'Archive' : 'Restore'} ${account.displayName}? ${archived ? 'The account will be disabled and hidden; its credit and account history will remain.' : 'The account will be re-enabled.'}`)) return;
        await archiveAccount({ targetUid: account.uid, archived });
      } else if (button.dataset.partnerAction === 'transfer') {
        transferTarget = account;
        $('creditTransferRecipient').textContent = `${account.displayName} · ${account.role}`;
        const rules = partnerData.transferRules || {};
        const minimum = actor.role === 'reseller' && account.role === 'provider' ? Number(rules.resellerToProviderMin || 20) : 1;
        const perTransferMaximum = actor.role === 'distributor' && account.role === 'reseller'
          ? Number(rules.distributorToResellerMax || 250) : actor.credits;
        const maximum = Math.min(actor.credits, perTransferMaximum);
        $('creditTransferAmount').min = String(minimum);
        $('creditTransferAmount').max = String(maximum);
        $('creditTransferAmount').value = actor.role === 'reseller' && maximum >= minimum ? String(minimum) : '';
        const limitMessage = actor.role === 'distributor'
          ? `Maximum per Distributor → Reseller transfer: ${perTransferMaximum} credits.`
          : `Minimum per Reseller → Provider transfer: ${minimum} credits.`;
        $('creditTransferAvailable').textContent = `Available balance: ${actor.credits} credits. ${limitMessage} Each transfer and its ledger entry are saved together.`;
        $('creditTransferError').textContent = '';
        $('creditTransferForm').querySelector('[type="submit"]').disabled = maximum < minimum;
        if (maximum < minimum) $('creditTransferError').textContent = `You need at least ${minimum} available credits for this transfer.`;
        openDialog('creditTransferDialog');
        return;
      } else if (button.dataset.partnerAction === 'adjust' && actor.role === 'admin') {
        const delta = Number(prompt(`Credit adjustment for ${account.displayName}. Positive adds, negative removes.`, '')); if (!Number.isSafeInteger(delta) || delta === 0) return;
        await adjustPartnerCredits({ targetUid: account.uid, delta });
      } else if (button.dataset.partnerAction === 'role') {
        const row = button.closest('tr') || button.closest('.accountCard');
        const newRole = row.querySelector(`[data-role-for="${CSS.escape(account.uid)}"]`)?.value;
        const newParentUid = row.querySelector(`[data-parent-for="${CSS.escape(account.uid)}"]`)?.value || null;
        if (!newRole || !confirm(`Change ${account.displayName} to ${newRole}?`)) return;
        await changePartnerRole({ targetUid: account.uid, newRole, newParentUid });
      }
      await refreshDashboard();
    } catch(error) { alert(friendlyError(error)); }
  };
  $('accountsBody').onchange = $('accountsCards').onchange = event => {
    const role = event.target.closest('[data-role-for]');
    const parentField = event.target.closest('[data-parent-for]');
    if (!role && !parentField) return;
    const uid = (role || parentField).dataset.roleFor || (role || parentField).dataset.parentFor;
    const row = event.target.closest('tr') || event.target.closest('.accountCard');
    const account = partnerData.accounts.find(item => item.uid === uid);
    if (!account || !row) return;
    const parent = row.querySelector(`[data-parent-for="${CSS.escape(uid)}"]`);
    if (role) {
      if (role.value === 'distributor') {
        parent.innerHTML = '<option value="">Admin</option>';
        parent.disabled = true;
      } else {
        const candidates = parentChoices(role.value, uid);
        const retainedParent = candidates.some(item => item.uid === account.parentUid) ? account.parentUid : '';
        parent.innerHTML = `<option value="" disabled ${retainedParent ? '' : 'selected'}>Choose ${requiredParentRole(role.value)} parent</option>${candidates.map(item => `<option value="${escapeHtml(item.uid)}" ${item.uid === retainedParent ? 'selected' : ''}>${escapeHtml(item.displayName)} · ${item.role}</option>`).join('')}`;
        parent.disabled = candidates.length === 0;
        parent.value = retainedParent;
      }
    }
    syncRoleEditor(row, account);
  };

  if (actor.role !== 'admin') return;
  const result = (await listDashboard()).data;
  $('deviceCount').textContent = result.activeDevices;
  $('keyCount').textContent = result.activeKeys;
  $('totalAppDevices').textContent = result.appUsage?.totalDevices ?? 0;
  $('active24h').textContent = result.appUsage?.active24h ?? 0;
  $('active7d').textContent = result.appUsage?.active7d ?? 0;
  $('active30d').textContent = result.appUsage?.active30d ?? 0;
  $('androidCount').textContent = result.platformCounts.android;
  $('windowsCount').textContent = result.platformCounts.windows;
  try {
    const credits = (await loadAdminCreditSummary()).data;
    $('creditsAllocated').textContent = Number(credits.totalAllocated ?? (Number(credits.allocated || 0) + Number(credits.adjustmentNet || 0))).toLocaleString();
    $('creditsInitialAllocation').textContent = Number(credits.allocated || 0).toLocaleString();
    $('creditsAdminAdjustments').textContent = Number(credits.adjustmentNet || 0).toLocaleString();
    $('creditsUsed').textContent = Number(credits.used || 0).toLocaleString();
    $('creditsHeld').textContent = Number(credits.held || 0).toLocaleString();
    $('creditsTransferred').textContent = Number(credits.transferred || 0).toLocaleString();
    $('creditsReconciliation').textContent = Number(credits.reconciliation || 0).toLocaleString();
    $('creditOverviewNote').textContent = 'Total allocated includes initial Distributor allocations plus signed Admin credit adjustments. Transfers between partners do not create additional credits.';
  } catch {
    for (const id of ['creditsAllocated','creditsInitialAllocation','creditsAdminAdjustments','creditsUsed','creditsHeld','creditsTransferred','creditsReconciliation']) $(id).textContent = '—';
    $('creditOverviewNote').textContent = 'Credit totals are temporarily unavailable. The rest of the Admin dashboard has loaded.';
  }
  adminKeys = result.keys;
  renderAdminKeys();
  $('devicesBody').innerHTML = result.devices.map(d => `<tr><td>${escapeHtml(d.platform)}</td><td>${escapeHtml(d.appVersion)}</td><td>${escapeHtml(d.portalHost || '—')}</td><td>${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : '—'}</td></tr>`).join('') || '<tr><td colspan="4">No registered devices yet</td></tr>';
  for (const id of ['androidMinimumVersion','windowsMinimumVersion','androidUpdateUrl','windowsUpdateUrl']) $(id).value = result.settings[id] || '';
  if (activeAdminTab === 'customers') loadAdminCustomers();
}

function loadAdminCustomers() {
  return refreshAdminProviderDashboard().catch(error => {
    $('adminCustomerError').textContent = friendlyError(error);
  });
}
async function refreshAdminProviderDashboard() {
  $('adminCustomerError').textContent = '';
  const data = (await adminProviderDashboard()).data;
  const archivedCount = data.customers.filter(customer => customer.archived).length;
  const customers = data.customers.filter(customer => (customer.archived === true) === showArchivedAdminCustomers);
  $('adminCustomerSummary').textContent = `${customers.length} ${showArchivedAdminCustomers ? 'archived ' : ''}customer device${customers.length === 1 ? '' : 's'}${data.hasMore ? ' · latest 500' : ''}`;
  $('toggleArchivedAdminCustomers').textContent = showArchivedAdminCustomers ? `Show active customers (${data.customers.length - archivedCount})` : `Show archived customers (${archivedCount})`;
  setVisible('toggleArchivedAdminCustomers', archivedCount > 0);
  const labels = { active: 'Active', trial: '7-day trial', grace: 'Grace period', expired: 'Expired', disabled: 'Disabled' };
  const statusLabel = customer => customer.archived ? 'Archived' : labels[customer.licenseState] || 'Unknown';
  const statusClass = customer => !customer.archived && ['active','trial'].includes(customer.licenseState) ? 'on' : 'off';
  const customerButtons = customer => (customer.archived
    ? `<button class="textButton" data-customer-archive="${escapeHtml(customer.deviceRef)}" data-archived="true">Restore customer</button>`
    : `<button class="textButton" data-admin-license="${escapeHtml(customer.licenseId)}" data-active="${customer.active}">${customer.active ? 'Disable license' : 'Enable license'}</button><button class="textButton" data-customer-archive="${escapeHtml(customer.deviceRef)}" data-archived="false">Archive customer</button>`) + `<button type="button" class="textButton dangerAction" data-customer-delete="${escapeHtml(customer.deviceRef)}">Delete customer</button>`;
  $('adminCustomerCards').innerHTML = customers.map(customer => `<article class="customerCard adminCustomerCard"><div class="customerCardHead"><div><b>${escapeHtml(customer.customerLabel)}</b><small>${escapeHtml(customer.providerName)} · ${escapeHtml(customer.partnerRole || 'partner')}</small></div><span class="tag ${statusClass(customer)}">${escapeHtml(statusLabel(customer))}</span></div><p class="customerCardExpiry">${customer.trial ? 'Trial until' : 'License until'} <b>${escapeHtml(formatDate(customer.trialExpiresAt || customer.licenseExpiresAt))}</b></p><details class="accountDetails"><summary>Device & account details</summary><div class="detailGrid"><span>Parent account</span><b>${escapeHtml(customer.parentName || 'Admin')}</b><span>Created by</span><b>${escapeHtml(customer.createdByName || '—')}</b><span>Creator email</span><b>${escapeHtml(customer.createdByEmail || '—')}</b><span>Device ID</span><code>${escapeHtml(customer.deviceId || '—')}</code><span>Portal MAC</span><code>${escapeHtml(customer.portalMac || '—')}</code><span>Platform</span><b>${escapeHtml(customer.platform || '—')}</b><span>Portal</span><b>${escapeHtml(customer.portalName)} · ${escapeHtml(customer.portalHost || 'host unavailable')}</b><span>Portal expiry</span><b>${escapeHtml(formatDate(customer.portalExpiresAt))}</b><span>Last sync</span><b>${escapeHtml(formatDateTime(customer.lastSyncedAt))}</b></div>${customer.archived ? '' : `<div class="cardField"><span>Portal for this customer</span>${customerPortalControl(customer, data.profiles || [])}</div>`}${customerButtons(customer)}</details></article>`).join('') || `<p class="muted">No ${showArchivedAdminCustomers ? 'archived ' : ''}customers yet.</p>`;
  bindPortalChoices($('adminCustomerCards'));
  $('adminCustomerCards').onclick = async event => {
    const deleteButton = event.target.closest('[data-customer-delete]');
    if (deleteButton) {
      deleteButton.disabled = true;
      try { await reviewDeletion('customer', deleteButton.dataset.customerDelete); }
      catch (error) { $('adminCustomerError').textContent = friendlyError(error); }
      finally { deleteButton.disabled = false; }
      return;
    }
    const portalButton = event.target.closest('[data-switch-portal]');
    if (portalButton) { await applyCustomerPortal(portalButton, refreshAdminProviderDashboard, 'adminCustomerError'); return; }
    const archiveButton = event.target.closest('[data-customer-archive]');
    if (archiveButton) {
      const archived = archiveButton.dataset.archived !== 'true';
      if (!confirm(`${archived ? 'Archive' : 'Restore'} this customer? ${archived ? 'The app license will be disabled, and customer, credit, and license history will be kept.' : 'The previous license state will be restored.'}`)) return;
      archiveButton.disabled = true;
      try { await archiveCustomer({ deviceRef: archiveButton.dataset.customerArchive, archived }); await refreshDashboard(); }
      catch (error) { alert(friendlyError(error)); archiveButton.disabled = false; }
      return;
    }
    const button = event.target.closest('[data-admin-license]'); if (!button) return;
    const active = button.dataset.active !== 'true';
    if (!confirm(`${active ? 'Enable' : 'Disable'} this customer app license?`)) return;
    button.disabled = true;
    try { await setKeyStatus({ keyId: button.dataset.adminLicense, active }); await refreshDashboard(); }
    catch (error) { alert(friendlyError(error)); button.disabled = false; }
  };
}

function activityLabel(type) { return ({transfer:'Credit transfer',admin_allocation:'Admin allocation',admin_adjustment:'Admin credit adjustment',license_issued:'Customer license activated',license_renewal:'License renewed'})[type] || type; }
function customerLabelForDevice(deviceRef, customers) { return customers.find(item => item.deviceRef === deviceRef)?.customerLabel || 'customer'; }
function formatDate(value) { return value ? new Date(value).toLocaleDateString() : 'Not set'; }
async function refreshProviderDashboard() {
  $('providerError').textContent = '';
  const data = (await providerDashboard()).data;
  const activeCustomers = data.customers.filter(customer => !customer.archived);
  const customers = data.customers.filter(customer => (customer.archived === true) === showArchivedPartnerCustomers);
  const archivedCount = data.customers.filter(customer => customer.archived).length;
  $('providerSummary').textContent = `${activeCustomers.length} customer${activeCustomers.length === 1 ? '' : 's'} · ${data.account.credits} credits`;
  $('partnerOverviewCredits').textContent = Number(data.account.credits || 0).toLocaleString();
  $('partnerOverviewCustomers').textContent = activeCustomers.length.toLocaleString();
  $('partnerOverviewActive').textContent = activeCustomers.filter(item => ['active','trial'].includes(item.licenseState)).length.toLocaleString();
  $('partnerOverviewPortals').textContent = data.profiles.filter(profile => profile.active).length.toLocaleString();
  const activeProfiles = data.profiles.filter(profile => profile.active);
  const profileOptions = activeProfiles.map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)} · ${escapeHtml(profile.host)}</option>`).join('');
  $('pairingProfile').innerHTML = profileOptions || '<option value="">Create an active portal profile first</option>';
  $('pairingProfile').disabled = !profileOptions;
  $('profilesList').innerHTML = data.profiles.map(profile => `<article class="profileItem"><div><b>${escapeHtml(profile.name)}</b><small>${escapeHtml(profile.host || 'Host unavailable')} · ${profile.active ? 'Active' : profile.expired ? 'Expired' : 'Inactive'} · expires ${escapeHtml(formatDate(profile.expiresAt))} · revision ${profile.revision}</small></div><button class="textButton" data-profile-edit="${escapeHtml(profile.id)}">Edit</button></article>`).join('') || '<p class="muted">No portal profiles yet.</p>';
  $('profilesList').onclick = async event => {
    const button = event.target.closest('[data-profile-edit]'); if (!button) return;
    const profile = data.profiles.find(item => item.id === button.dataset.profileEdit); if (!profile) return;
    editingProfile = profile;
    $('editProfileName').value = profile.name;
    $('editProfileUrl').value = '';
    $('editProfileExpiry').value = localDateTimeValue(profile.expiresAt);
    $('portalEditError').textContent = '';
    openDialog('portalEditDialog');
  };
  partnerLicenses = data.customers;
  renderPartnerLicenses();
  $('toggleArchivedPartnerCustomers').textContent = showArchivedPartnerCustomers ? `Show active customers (${data.customers.length - archivedCount})` : `Show archived customers (${archivedCount})`;
  setVisible('toggleArchivedPartnerCustomers', archivedCount > 0);
  const renewalControl = customer => customer.active && customer.licenseState !== 'disabled'
    ? `<div class="renewControls"><select data-renew-years aria-label="${customer.trial ? 'Activation' : 'Renewal'} term for ${escapeHtml(customer.customerLabel)}">${licenseYearOptions()}</select><button class="textButton" data-renew-device="${escapeHtml(customer.deviceRef)}">${customer.trial ? 'Activate license' : 'Renew'}</button></div>` : '—';
  $('customerCards').innerHTML = customers.map(customer => `<article class="customerCard compactCustomerCard"><div class="customerCardHead"><div><b>${escapeHtml(customer.customerLabel)}</b><small>${escapeHtml(customer.platform || 'Device')}</small></div><span class="tag ${!customer.archived && ['active','trial'].includes(customer.licenseState) ? 'on' : 'off'}">${customer.archived ? 'Archived' : escapeHtml(licenseStatusLabel[customer.licenseState] || 'Unknown')}</span></div><p class="customerCardExpiry">${customer.trial ? 'Trial until' : 'License until'} <b>${escapeHtml(formatDate(customer.trialExpiresAt || customer.licenseExpiresAt))}</b></p><details class="accountDetails customerManageDetails"><summary>${customer.archived ? 'Archived details & restore' : 'Manage customer & device details'}</summary>${customer.archived ? '' : `<div class="cardField"><span>Portal for this customer</span>${customerPortalControl(customer, activeProfiles)}</div>`}<div class="detailGrid"><span>Device ID</span><code>${escapeHtml(customer.deviceId || customer.deviceRef || '—')}</code><span>Portal MAC</span><code>${escapeHtml(customer.portalMac || '—')}</code><span>Portal expiry</span><b>${escapeHtml(formatDate(customer.portalExpiresAt))}</b><span>Last sync</span><b>${escapeHtml(formatDateTime(customer.lastSyncedAt))}</b><span>${customer.trial ? 'Trial' : 'License grace'}</span><b>${customer.trial ? '7 days, no credits' : customer.licenseState === 'grace' ? `Until ${escapeHtml(formatDate(customer.graceUntil))}` : 'Seven days after expiry'}</b></div>${customer.archived ? `<button class="textButton customerArchiveAction" data-customer-archive="${escapeHtml(customer.deviceRef)}" data-archived="true">Restore customer</button>` : `<div class="customerRenew">${renewalControl(customer)}</div><button class="textButton customerArchiveAction" data-customer-archive="${escapeHtml(customer.deviceRef)}" data-archived="false">Archive customer</button>`}</details></article>`).join('') || `<p class="muted">No ${showArchivedPartnerCustomers ? 'archived ' : ''}customer devices assigned yet.</p>`;
  const handleCustomerAction = async event => {
    const archiveButton = event.target.closest('[data-customer-archive]');
    if (archiveButton) {
      const archived = archiveButton.dataset.archived !== 'true';
      if (!confirm(`${archived ? 'Archive' : 'Restore'} this customer? ${archived ? 'The app license will be disabled, while customer, credit, and license history are kept.' : 'The previous license state will be restored.'}`)) return;
      archiveButton.disabled = true;
      try { await archiveCustomer({ deviceRef: archiveButton.dataset.customerArchive, archived }); await refreshDashboard(); }
      catch (error) { $('providerError').textContent = friendlyError(error); archiveButton.disabled = false; }
      return;
    }
    const switchButton = event.target.closest('[data-switch-portal]');
    if (switchButton) {
      await applyCustomerPortal(switchButton, refreshProviderDashboard, 'providerError');
      return;
    }
    const button = event.target.closest('[data-renew-device]'); if (!button) return;
    const years = Number(button.closest('tr, .customerCard')?.querySelector('[data-renew-years]')?.value);
    if (!Number.isSafeInteger(years) || years < 1 || years > 10) return;
    const selectedCustomer = data.customers.find(item => item.deviceRef === button.dataset.renewDevice);
    if (!confirm(`${selectedCustomer?.trial ? 'Activate' : 'Renew'} ${customerLabelForDevice(button.dataset.renewDevice, data.customers)} for ${years} year${years === 1 ? '' : 's'} using ${years} credit${years === 1 ? '' : 's'}?`)) return;
    button.disabled = true;
    try { const result = (await renewDeviceLicense({ deviceRef: button.dataset.renewDevice, years })).data; await refreshDashboard(); $('providerError').textContent = `${result.activatedFromTrial ? 'Trial converted to license' : 'License renewed'} until ${new Date(result.expiresAt).toLocaleDateString()}. ${result.remainingCredits} credits remain.`; }
    catch (error) { $('providerError').textContent = friendlyError(error); button.disabled = false; }
  };
  bindPortalChoices($('customerCards'));
  $('customerCards').onclick = handleCustomerAction;
}

$('deleteForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!pendingDeletion || $('deleteConfirmation').value !== 'DELETE') return;
  const submit = event.submitter;
  submit.disabled = true;
  $('deleteError').textContent = '';
  try {
    const result = (await deleteRecord({ kind: pendingDeletion.kind, targetId: pendingDeletion.targetId,
      confirmationToken: pendingDeletion.confirmationToken, confirmation: 'DELETE' })).data;
    if (result.authCleanupPending) {
      $('deleteSummary').textContent = 'Records deleted, credits settled, and access blocked. Some sign-in records still need cleanup. Press Retry sign-in cleanup to retry safely.';
      submit.textContent = 'Retry sign-in cleanup';
      return;
    }
    closeDialog('deleteDialog');
    pendingDeletion = null;
    try { await refreshDashboard(); } catch { $('dashboardError').textContent = 'Deleted successfully. Refresh the dashboard to update the lists.'; }
  } catch (error) { $('deleteError').textContent = friendlyError(error); }
  finally { submit.disabled = false; }
});

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault(); $('loginError').textContent = '';
  try { await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value); }
  catch(error) { $('loginError').textContent = friendlyError(error); }
});
$('logout').addEventListener('click', () => signOut(auth));
$('showMoreKeys').addEventListener('click', () => { showAllAdminKeys = !showAllAdminKeys; renderAdminKeys(); });
$('showMorePartnerLicenses').addEventListener('click', () => { showAllPartnerLicenses = !showAllPartnerLicenses; renderPartnerLicenses(); });
$('toggleArchivedKeys').addEventListener('click', () => { showArchivedKeys = !showArchivedKeys; showAllAdminKeys = false; renderAdminKeys(); });
$('toggleArchivedPartnerLicenses').addEventListener('click', () => { showArchivedPartnerLicenses = !showArchivedPartnerLicenses; showAllPartnerLicenses = false; renderPartnerLicenses(); });
$('toggleArchivedAccounts').addEventListener('click', () => { showArchivedAccounts = !showArchivedAccounts; refreshDashboard().catch(error => $('dashboardError').textContent = friendlyError(error)); });
$('toggleArchivedAdminCustomers').addEventListener('click', () => { showArchivedAdminCustomers = !showArchivedAdminCustomers; loadAdminCustomers(); });
$('toggleArchivedPartnerCustomers').addEventListener('click', () => { showArchivedPartnerCustomers = !showArchivedPartnerCustomers; refreshProviderDashboard().catch(error => $('providerError').textContent = friendlyError(error)); });
$('refreshPartner').addEventListener('click', () => refreshDashboard().catch(e => alert(friendlyError(e))));
$('createPartner').addEventListener('click', () => {
  if (!currentPartnerActor || !currentPartnerData) return;
  const actor = currentPartnerActor, limits = currentPartnerData.limits || {}, rules = currentPartnerData.transferRules || {};
  const role = actor.role === 'admin' ? 'distributor' : actor.role === 'distributor' ? 'reseller' : 'provider';
  const minimum = actor.role === 'admin' ? Number(limits.distributorMinCredits || 500) : actor.role === 'reseller' ? Number(rules.resellerToProviderMin || 20) : 0;
  const maximum = actor.role === 'admin' ? null : actor.role === 'distributor' ? Math.min(actor.credits, Number(rules.distributorToResellerMax || 250)) : actor.credits;
  $('partnerAccountForm').reset();
  $('partnerAccountDialogTitle').textContent = `Create ${role}`;
  $('partnerCredits').min = String(minimum);
  if (maximum === null) $('partnerCredits').removeAttribute('max'); else $('partnerCredits').max = String(maximum);
  $('partnerCredits').value = String(Math.max(minimum, Math.min(role === 'distributor' ? 500 : 20, maximum ?? Number.MAX_SAFE_INTEGER)));
  $('partnerAccountHelp').textContent = actor.role === 'admin'
    ? `A Distributor needs at least ${minimum} opening credits. This Admin allocation is recorded in the ledger.`
    : `Available: ${actor.credits} credits. Opening credits are transferred from your balance in the same transaction; each credit covers one license year.`;
  $('partnerAccountError').textContent = maximum !== null && maximum < minimum ? `You need at least ${minimum} credits available to create a ${role}.` : '';
  $('partnerAccountForm').querySelector('[type="submit"]').disabled = maximum !== null && maximum < minimum;
  openDialog('partnerAccountDialog');
});
$('partnerAccountForm').addEventListener('submit', async event => {
  event.preventDefault();
  const actor = currentPartnerActor, role = actor?.role === 'admin' ? 'distributor' : actor?.role === 'distributor' ? 'reseller' : 'provider';
  const displayName = $('partnerName').value.trim(), email = $('partnerEmail').value.trim(), credits = Number($('partnerCredits').value);
  if (!Number.isSafeInteger(credits) || credits < Number($('partnerCredits').min) || ($('partnerCredits').max && credits > Number($('partnerCredits').max))) {
    $('partnerAccountError').textContent = 'Enter a whole number of credits within the available range.'; return;
  }
  const submit = $('partnerAccountForm').querySelector('[type="submit"]'); submit.disabled = true; $('partnerAccountError').textContent = '';
  try {
    const callable = role === 'distributor' ? createDistributor : createPartnerChild;
    const payload = role === 'distributor' ? { displayName, email, credits } : { displayName, email, credits, role };
    const created = (await callable(payload)).data;
    $('accountResult').innerHTML = `Account created for ${escapeHtml(created.email)}. Set the password using this one-time link:<br><a href="${escapeHtml(created.passwordResetLink)}" target="_blank" rel="noopener">Open password setup</a>`;
    setVisible('accountResult', true); closeDialog('partnerAccountDialog'); await refreshDashboard();
  } catch(error) { $('partnerAccountError').textContent = friendlyError(error); }
  finally { submit.disabled = false; }
});
$('creditTransferForm').addEventListener('submit', async event => {
  event.preventDefault();
  const amount = Number($('creditTransferAmount').value);
  const minimum = Number($('creditTransferAmount').min || 1);
  const maximum = Number($('creditTransferAmount').max || currentPartnerActor?.credits || 0);
  if (!transferTarget || !Number.isSafeInteger(amount) || amount < minimum || amount > maximum) {
    $('creditTransferError').textContent = `Enter a whole-number amount from ${minimum} to ${maximum} credits.`; return;
  }
  if (!confirm(`Transfer ${amount} credit${amount === 1 ? '' : 's'} to ${transferTarget.displayName}?`)) return;
  const submit = $('creditTransferForm').querySelector('[type="submit"]'); submit.disabled = true; $('creditTransferError').textContent = '';
  try {
    await transferCredits({ targetUid: transferTarget.uid, amount });
    transferTarget = null; closeDialog('creditTransferDialog'); await refreshDashboard();
  } catch (error) { $('creditTransferError').textContent = friendlyError(error); }
  finally { submit.disabled = false; }
});
$('portalEditForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!editingProfile) return;
  const expiryText = $('editProfileExpiry').value;
  const expiresAt = expiryText ? new Date(expiryText).getTime() : null;
  if (expiryText && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) { $('portalEditError').textContent = 'Enter a future portal expiry date and time.'; return; }
  const submit = $('portalEditForm').querySelector('[type="submit"]'); submit.disabled = true; $('portalEditError').textContent = '';
  try {
    await updatePortalProfile({ profileId: editingProfile.id, name: $('editProfileName').value.trim(), portalUrl: $('editProfileUrl').value.trim(), expiresAt });
    editingProfile = null; closeDialog('portalEditDialog'); await refreshProviderDashboard();
    $('providerError').textContent = 'Portal profile saved. Assigned apps receive it on their next sync.';
  } catch (error) { $('portalEditError').textContent = friendlyError(error); }
  finally { submit.disabled = false; }
});
document.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => closeDialog(button.dataset.closeDialog)));
$('refresh').addEventListener('click', () => refreshDashboard().catch(e => alert(friendlyError(e))));
$('refreshAdminCustomers').addEventListener('click', loadAdminCustomers);
$('newKey').addEventListener('click', async () => {
  const answer = prompt('Key label (optional):'); if (answer === null) return;
  const limit = Number(prompt('Maximum devices for this key?', '1') || 1);
  const expiryInput = prompt('Exact expiry date/time in your local time (YYYY-MM-DDTHH:mm), or leave blank for no expiry:', '');
  if (expiryInput === null) return;
  const expiresAt = expiryInput.trim() ? new Date(expiryInput).getTime() : null;
  if (expiryInput.trim() && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) { alert('Enter a future expiry date and time.'); return; }
  try {
    const result = (await createKey({ label:answer, deviceLimit:limit, expiresAt })).data;
    $('newKeyResult').innerHTML = `Copy and save this key now; it is only shown once:<br><code>${escapeHtml(result.key)}</code>`;
    setVisible('newKeyResult', true); await refreshDashboard();
  } catch(error) { alert(friendlyError(error)); }
});
$('versionsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(['androidMinimumVersion','windowsMinimumVersion','androidUpdateUrl','windowsUpdateUrl'].map(id => [id,$(id).value.trim()]));
  try { await setVersionRules(values); alert('Minimum app versions saved.'); await refreshDashboard(); }
  catch(error) { alert(friendlyError(error)); }
});
$('partnerLimitsForm').addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(['distributorMinCredits','distributorToResellerMax','resellerToProviderMin'].map(id => [id,Number($(id).value)]));
  if (Object.values(values).some(value => !Number.isSafeInteger(value) || value < 1 || value > 1000000)) { alert('Limits must be whole numbers from 1 to 1,000,000.'); return; }
  try { await savePartnerLimits(values); alert('Partner limits saved.'); await refreshDashboard(); }
  catch(error) { alert(friendlyError(error)); }
});

$('refreshProvider').addEventListener('click', () => refreshProviderDashboard().catch(error => { $('providerError').textContent = friendlyError(error); }));
$('pairCustomer').addEventListener('click', () => {
  setVisible('adminPairingOwnerField', false);
  $('adminPairingOwner').required = false;
  $('pairingDialogTitle').textContent = 'Assign a device';
  $('pairingHelp').textContent = `Choose a free 7-day app trial or activate a 1–10 year license. Trial does not use credits and can be used once per device; after the trial, activate a paid term.`;
  $('providerError').textContent = '';
  $('pairingResult').textContent = '';
  openDialog('pairCustomerDialog');
});
$('pairAdminCustomer').addEventListener('click', () => {
  const targets = (currentPartnerData?.accounts || [])
    .filter(account => account.active && ['distributor','reseller','provider'].includes(account.role))
    .sort((a, b) => `${a.displayName} ${a.role}`.localeCompare(`${b.displayName} ${b.role}`));
  $('adminCustomerError').textContent = '';
  $('adminPairingNotice').textContent = '';
  $('adminPairingOwner').innerHTML = '<option value="">Choose an active partner</option>' + targets.map(account => `<option value="${escapeHtml(account.uid)}">${escapeHtml(account.displayName)} · ${escapeHtml(account.role)} · ${account.credits} credits</option>`).join('');
  $('adminPairingOwner').value = '';
  $('adminPairingOwner').required = true;
  $('pairingProfile').innerHTML = '<option value="">Choose a partner first</option>';
  $('pairingProfile').disabled = true;
  $('adminPairingCreditNote').textContent = 'Choose who will own this customer. A new license uses credits from that partner.';
  $('pairingDialogTitle').textContent = 'Add customer to a partner';
  $('pairingHelp').textContent = `Choose the active partner that will own this customer, then enter the short-lived code. Trial is free for 7 days; a paid license uses 1 credit per year.`;
  $('pairingResult').textContent = '';
  setVisible('adminPairingOwnerField', true);
  openDialog('pairCustomerDialog');
});
$('pairingMode').addEventListener('change', () => setVisible('durationYearsField', $('pairingMode').value === 'paid'));
$('pairingMode').dispatchEvent(new Event('change'));
$('adminPairingOwner').addEventListener('change', async () => {
  const partnerUid = $('adminPairingOwner').value;
  $('pairingResult').textContent = '';
  $('pairingProfile').disabled = true;
  $('pairingProfile').innerHTML = '<option value="">Loading active STB profiles…</option>';
  if (!partnerUid) {
    $('pairingProfile').innerHTML = '<option value="">Choose a partner first</option>';
    $('adminPairingCreditNote').textContent = 'Choose who will own this customer. A new license uses credits from that partner.';
    return;
  }
  const partner = currentPartnerData?.accounts.find(account => account.uid === partnerUid);
  try {
    const data = (await adminListPairingProfiles({ partnerUid })).data;
    adminPairingProfiles = data.profiles;
    $('pairingProfile').innerHTML = data.profiles.map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)} · ${escapeHtml(profile.host || 'host unavailable')}</option>`).join('') || '<option value="">No active STB profiles</option>';
    $('pairingProfile').disabled = data.profiles.length === 0;
    $('adminPairingCreditNote').textContent = data.profiles.length
      ? `${data.partner.displayName} has ${data.partner.credits} credits. A 7-day trial costs 0 credits; a paid 1–10 year license uses 1 credit per year.`
      : `${data.partner.displayName} has no active STB profiles. Add one in that account's Settings before pairing a customer.`;
  } catch (error) {
    adminPairingProfiles = [];
    $('pairingProfile').innerHTML = '<option value="">Could not load profiles</option>';
    $('adminPairingCreditNote').textContent = friendlyError(error);
  }
  if (partner && !adminPairingProfiles.length) $('pairingProfile').disabled = true;
});
$('portalProfileForm').addEventListener('submit', async event => {
  event.preventDefault(); $('providerError').textContent = '';
  const name = $('profileName').value.trim(), portalUrl = $('profileUrl').value.trim(), expiryText = $('profileExpiry').value;
  const expiresAt = expiryText ? new Date(expiryText).getTime() : null;
  if (expiryText && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) { $('providerError').textContent = 'Portal expiry must be a future date and time.'; return; }
  try {
    await createPortalProfile({ name, portalUrl, expiresAt });
    $('portalProfileForm').reset(); await refreshProviderDashboard();
  } catch (error) { $('providerError').textContent = friendlyError(error); }
});
$('pairingForm').addEventListener('submit', async event => {
  event.preventDefault(); $('pairingResult').textContent = '';
  const actor = currentPartnerActor;
  const isAdmin = actor?.role === 'admin';
  const partnerUid = isAdmin ? $('adminPairingOwner').value : '';
  const pairingCode = $('pairingCode').value.trim().toUpperCase(), profileId = $('pairingProfile').value;
  if (isAdmin && !partnerUid) { $('pairingResult').textContent = 'Choose which partner account will own this customer.'; return; }
  if (!profileId) { $('pairingResult').textContent = 'Choose an active STB profile first.'; return; }
  const submit = $('pairingForm').querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const trial = $('pairingMode').value === 'trial';
    const years = Number($('durationYears').value);
    const payload = { pairingCode, profileId, customerLabel: $('customerLabel').value.trim(), trial };
    if (!trial) payload.durationYears = years;
    if (isAdmin) payload.partnerUid = partnerUid;
    const result = (await completePairing(payload)).data;
    const ownerName = result.ownerName || actor?.displayName || actor?.role || 'Partner';
    const summary = result.existingLicense
      ? `${ownerName}: existing license kept; no credits deducted. Balance remains ${result.remainingCredits} credits.`
      : result.trial ? `7-day app trial started for ${ownerName}; 0 credits used. Activate a paid license before the trial ends.` : `${years}-year customer license activated. ${result.creditsUsed} credits deducted from ${ownerName}; new balance: ${result.remainingCredits}.`;
    $('pairingForm').reset(); $('pairingMode').dispatchEvent(new Event('change'));
    closeDialog('pairCustomerDialog');
    if (isAdmin) $('adminPairingNotice').textContent = summary;
    else $('providerError').textContent = summary;
    try { await refreshDashboard(); }
    catch (refreshError) {
      const message = 'Customer pairing succeeded, but the dashboard did not refresh. Reload the panel to see the updated balance.';
      if (isAdmin) $('adminCustomerError').textContent = `${message} ${friendlyError(refreshError)}`;
      else $('providerError').textContent = `${summary} ${message}`;
    }
  } catch (error) { $('pairingResult').textContent = friendlyError(error); }
  finally { submit.disabled = false; }
});

onAuthStateChanged(auth, async user => {
  setVisible('login', !user); setVisible('dashboard', !!user); setVisible('logout', !!user);
  if (user) { try { await refreshDashboard(); } catch(error) { $('dashboardError').textContent = friendlyError(error); } }
});
