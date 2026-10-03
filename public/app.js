import { auth, functions } from './firebase-config.js';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';

const $ = id => document.getElementById(id);
const listDashboard = httpsCallable(functions, 'adminListDashboard');
const createKey = httpsCallable(functions, 'adminCreateKey');
const setKeyStatus = httpsCallable(functions, 'adminSetKeyStatus');
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
let partnerLicenses = [];
let showAllPartnerLicenses = false;
const licenseStatusLabel = { active: 'Active', grace: 'Grace period', expired: 'Expired', disabled: 'Disabled' };
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
function renderAdminKeys() {
  const rows = showAllAdminKeys ? adminKeys : adminKeys.slice(0, 10);
  $('keyListCount').textContent = adminKeys.length ? `Showing ${rows.length} of ${adminKeys.length}${adminKeys.length === 250 ? ' latest loaded' : ''} keys` : '';
  $('showMoreKeys').textContent = showAllAdminKeys ? 'Show fewer' : 'Show more';
  setVisible('showMoreKeys', adminKeys.length > 10);
  const state = k => k.expired ? 'Expired' : k.active ? 'Active' : 'Disabled';
  const stateClass = k => k.expired || !k.active ? 'off' : 'on';
  const creatorDetails = k => `<details class="accountDetails"><summary>Key details & creator</summary><div class="detailGrid"><span>Created by</span><b>${escapeHtml(k.createdByName || (k.createdBy ? 'Admin (name unavailable)' : 'Unknown legacy creator'))}</b><span>Role</span><b>${escapeHtml(k.createdByRole || '—')}</b><span>Email</span><b>${escapeHtml(k.createdByEmail || '—')}</b><span>Account ID</span><code>${escapeHtml(k.createdBy || '—')}</code><span>Created</span><b>${escapeHtml(formatDateTime(k.createdAt))}</b><span>Device assignments</span><b>${k.deviceCount} / ${k.deviceLimit}</b></div></details>`;
  const statusButton = k => `<button type="button" class="textButton" data-key="${escapeHtml(k.id)}" data-active="${k.active}">${k.active ? 'Disable' : 'Enable'}</button>`;
  $('keysBody').innerHTML = rows.map(k => `<tr><td><b>${escapeHtml(k.label || '—')}</b><br><small>•••• ${escapeHtml(k.keyHint || '—')}</small>${creatorDetails(k)}</td><td>${k.deviceCount} / ${k.deviceLimit}</td><td>${k.expiresAt ? new Date(k.expiresAt).toLocaleString() : 'Never'}</td><td><span class="tag ${stateClass(k)}">${state(k)}</span></td><td>${statusButton(k)}</td></tr>`).join('') || '<tr><td colspan="5">No keys yet</td></tr>';
  $('keyCards').innerHTML = rows.map(k => `<article class="keyCard customerCard"><div class="customerCardHead"><div><b>${escapeHtml(k.label || '—')}</b><small>•••• ${escapeHtml(k.keyHint || '—')}</small></div><span class="tag ${stateClass(k)}">${state(k)}</span></div><div class="detailGrid keySummary"><span>Devices</span><b>${k.deviceCount} / ${k.deviceLimit}</b><span>Expires</span><b>${escapeHtml(k.expiresAt ? new Date(k.expiresAt).toLocaleString() : 'Never')}</b></div><div class="keyCardActions">${creatorDetails(k)}${statusButton(k)}</div></article>`).join('') || '<p class="muted">No keys yet.</p>';
  document.querySelectorAll('#keysBody [data-key], #keyCards [data-key]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await setKeyStatus({ keyId:button.dataset.key, active:button.dataset.active !== 'true' }); await refreshDashboard(); }
    catch(error) { alert(friendlyError(error)); button.disabled = false; }
  }));
}
function renderPartnerLicenses() {
  const rows = showAllPartnerLicenses ? partnerLicenses : partnerLicenses.slice(0, 10);
  $('partnerLicenseCount').textContent = partnerLicenses.length ? `Showing ${rows.length} of ${partnerLicenses.length}${partnerLicenses.length === 500 ? ' latest loaded' : ''} licenses` : '';
  $('showMorePartnerLicenses').textContent = showAllPartnerLicenses ? 'Show fewer' : 'Show more';
  setVisible('showMorePartnerLicenses', partnerLicenses.length > 10);
  $('partnerKeysBody').innerHTML = rows.map(customer => `<tr><td>${escapeHtml(customer.customerLabel)}</td><td>${customer.keyHint ? `•••• ${escapeHtml(customer.keyHint)}` : 'Legacy license'}</td><td>${escapeHtml(customer.createdByName || '—')}</td><td>${customer.durationYears} year${customer.durationYears === 1 ? '' : 's'}</td><td><span class="tag ${customer.licenseState === 'active' ? 'on' : 'off'}">${escapeHtml(licenseStatusLabel[customer.licenseState] || 'Unknown')}</span></td><td>${escapeHtml(formatDate(customer.licenseExpiresAt))}</td></tr>`).join('') || '<tr><td colspan="6">No customer licenses created by this account yet.</td></tr>';
  $('partnerKeysCards').innerHTML = rows.map(customer => `<article class="customerCard"><div class="customerCardHead"><b>${escapeHtml(customer.customerLabel)}</b><span class="tag ${customer.licenseState === 'active' ? 'on' : 'off'}">${escapeHtml(licenseStatusLabel[customer.licenseState] || 'Unknown')}</span></div><p class="muted">License ${customer.keyHint ? `•••• ${escapeHtml(customer.keyHint)}` : 'created before key hints were recorded'} · ${customer.durationYears} year${customer.durationYears === 1 ? '' : 's'} · expires ${escapeHtml(formatDate(customer.licenseExpiresAt))}</p><small>Created by ${escapeHtml(customer.createdByName || '—')}</small></article>`).join('') || '<p class="muted">No customer licenses created by this account yet.</p>';
}
function showAdminTab(tab) {
  const role = currentPartnerActor?.role || 'admin';
  const isAdmin = role === 'admin';
  const views = isAdmin ? {
    overview: ['adminCreditOverview', 'statsPanel', 'devicesPanel'], keys: ['keysPanel'],
    partners: ['partnerPanel', 'partnerLimitsPanel'], customers: ['adminCustomersPanel']
  } : {
    overview: ['partnerOverviewPanel'], keys: ['partnerKeysPanel'],
    partners: role === 'provider' ? [] : ['partnerPanel'], customers: ['providerPanel'], settings: ['partnerSettingsPanel']
  };
  if (!views[tab]) tab = 'overview';
  activeAdminTab = tab;
  for (const id of ['adminCreditOverview','statsPanel','devicesPanel','keysPanel','partnerPanel','partnerLimitsPanel','adminCustomersPanel','partnerOverviewPanel','partnerKeysPanel','providerPanel','partnerSettingsPanel']) {
    setVisible(id, views[tab].includes(id));
  }
  document.querySelector('[data-admin-tab="partners"]').classList.toggle('hidden', !isAdmin && role === 'provider');
  document.querySelector('[data-admin-tab="settings"]').classList.toggle('hidden', isAdmin);
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
    const canTransfer = (actor.role === 'distributor' && account.role === 'reseller') || (actor.role === 'reseller' && account.role === 'provider');
    return `<div class="accountActions">${canTransfer ? `<button class="textButton" data-partner-action="transfer" data-uid="${escapeHtml(account.uid)}">Transfer credits</button>` : ''}${actor.role === 'admin' ? `<button class="textButton" data-partner-action="adjust" data-uid="${escapeHtml(account.uid)}">Adjust credits</button>` : ''}${canRoleChange(account) ? `<details class="roleEditor"><summary>Change role</summary><label>Role<select data-role-for="${escapeHtml(account.uid)}">${roleOptions(account)}</select></label><label>Parent<select data-parent-for="${escapeHtml(account.uid)}" ${account.role === 'distributor' ? 'disabled' : ''}>${parentOptions(account)}</select></label><p class="note roleHelp hidden" data-role-help="${escapeHtml(account.uid)}"></p><button class="ghost small" data-partner-action="role" data-uid="${escapeHtml(account.uid)}">Save role</button></details>` : ''}</div>`;
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
  $('accountsBody').innerHTML = allAccounts.map(a => `<tr><td><b>${escapeHtml(a.displayName)}</b><br><small>${escapeHtml(a.email)}</small></td><td>${escapeHtml(a.role)}</td><td>${escapeHtml(a.parentName || 'Admin')}</td><td>${a.credits}</td><td><span class="tag ${a.active?'on':'off'}">${a.active?'Active':'Disabled'}</span></td><td>${manage(a)}${details(a)}</td></tr>`).join('') || '<tr><td colspan="6">No accounts to show</td></tr>';
  $('accountsCards').innerHTML = allAccounts.map(a => `<article class="accountCard"><div class="accountCardHead"><div><b>${escapeHtml(a.displayName)}</b><small>${escapeHtml(a.role)} · under ${escapeHtml(a.parentName || 'Admin')}</small></div><strong>${a.credits} <small>credits</small></strong></div><div class="accountCardStatus"><span class="tag ${a.active?'on':'off'}">${a.active?'Active':'Disabled'}</span><small>Created ${escapeHtml(formatDate(a.createdAt))}</small></div>${details(a)}${manage(a)}</article>`).join('') || '<p class="muted">No accounts to show.</p>';
  document.querySelectorAll('#accountsBody tr, #accountsCards .accountCard').forEach(row => {
    const role = row.querySelector('[data-role-for]');
    const account = role && allAccounts.find(item => item.uid === role.dataset.roleFor);
    if (account) syncRoleEditor(row, account);
  });
  $('accountsBody').onclick = $('accountsCards').onclick = async event => {
    const button = event.target.closest('[data-partner-action]'); if (!button) return;
    const account = partnerData.accounts.find(a => a.uid === button.dataset.uid); if (!account) return;
    try {
      if (button.dataset.partnerAction === 'transfer') {
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
    $('creditsAllocated').textContent = Number(credits.allocated || 0).toLocaleString();
    $('creditsUsed').textContent = Number(credits.used || 0).toLocaleString();
    $('creditsHeld').textContent = Number(credits.held || 0).toLocaleString();
    $('creditsTransferred').textContent = Number(credits.transferred || 0).toLocaleString();
    $('creditsReconciliation').textContent = Number(credits.reconciliation || 0).toLocaleString();
    $('creditOverviewNote').textContent = `Net Admin adjustments: ${Number(credits.adjustmentNet || 0).toLocaleString()} credits. A zero reconciliation means Admin allocations and adjustments equal license usage plus partner balances.`;
  } catch {
    for (const id of ['creditsAllocated','creditsUsed','creditsHeld','creditsTransferred','creditsReconciliation']) $(id).textContent = '—';
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
  $('adminCustomerSummary').textContent = `${data.customers.length} assigned customer device${data.customers.length === 1 ? '' : 's'}${data.hasMore ? ' · showing the 500 most recently updated' : ''}`;
  const labels = { active: 'Active', grace: 'Grace period', expired: 'Expired', disabled: 'Disabled' };
  $('adminCustomersBody').innerHTML = data.customers.map(customer => `<tr><td>${escapeHtml(customer.customerLabel)}</td><td>${escapeHtml(customer.providerName)}<br><small>${escapeHtml(customer.partnerRole || 'partner')} · under ${escapeHtml(customer.parentName || 'Admin')}</small><details class="accountDetails"><summary>Key details</summary><div class="detailGrid"><span>Created by</span><b>${escapeHtml(customer.createdByName || '—')}</b><span>Creator email</span><b>${escapeHtml(customer.createdByEmail || '—')}</b><span>Creator ID</span><code>${escapeHtml(customer.createdBy || '—')}</code><span>Parent account</span><b>${escapeHtml(customer.parentName || 'Admin')}</b><span>Parent account ID</span><code>${escapeHtml(customer.parentUid || '—')}</code><span>License ID</span><code>${escapeHtml(customer.licenseId)}</code></div></details></td><td><code class="deviceReference">${escapeHtml(customer.deviceId || '—')}</code></td><td>${escapeHtml(customer.portalMac || '—')}</td><td>${escapeHtml(customer.platform || '—')}</td><td>${escapeHtml(customer.portalName)} · ${escapeHtml(customer.portalHost || 'host unavailable')}${customer.portalActive ? '' : ' · inactive'}</td><td><span class="tag ${customer.licenseState === 'active' ? 'on' : 'off'}">${escapeHtml(labels[customer.licenseState] || 'Unknown')}</span><br>${escapeHtml(formatDate(customer.licenseExpiresAt))}</td><td>${escapeHtml(formatDate(customer.portalExpiresAt))}</td><td>${customer.lastSyncedAt ? escapeHtml(new Date(customer.lastSyncedAt).toLocaleString()) : 'Never'}</td><td><button class="textButton" data-admin-license="${escapeHtml(customer.licenseId)}" data-active="${customer.active}">${customer.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('') || '<tr><td colspan="10">No provider-assigned customer devices yet</td></tr>';
  $('adminCustomersBody').onclick = async event => {
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
  $('providerSummary').textContent = `${data.customers.length} customer device${data.customers.length === 1 ? '' : 's'} · ${data.account.credits} credits`;
  $('partnerOverviewCredits').textContent = Number(data.account.credits || 0).toLocaleString();
  $('partnerOverviewCustomers').textContent = data.customers.length.toLocaleString();
  $('partnerOverviewActive').textContent = data.customers.filter(item => item.licenseState === 'active').length.toLocaleString();
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
  const portalControl = customer => `<div class="devicePortalControl"><select data-device-profile aria-label="Active portal for ${escapeHtml(customer.customerLabel)}"><option value="">Choose active portal</option>${activeProfiles.map(profile => `<option value="${escapeHtml(profile.id)}" ${profile.id === customer.portalProfileId ? 'selected' : ''}>${escapeHtml(profile.name)} · ${escapeHtml(profile.host)}</option>`).join('')}</select><button class="textButton" data-switch-portal="${escapeHtml(customer.deviceRef)}" ${activeProfiles.length ? '' : 'disabled'}>Switch portal</button><small>Current: ${escapeHtml(customer.portalName)}${customer.portalActive ? '' : ' · inactive'}</small></div>`;
  const renewalControl = customer => customer.active && customer.licenseState !== 'disabled'
    ? `<div class="renewControls"><select data-renew-years aria-label="Renewal term for ${escapeHtml(customer.customerLabel)}">${licenseYearOptions()}</select><button class="textButton" data-renew-device="${escapeHtml(customer.deviceRef)}">Renew</button></div>` : '—';
  $('customersBody').innerHTML = data.customers.map(customer => `<tr><td>${escapeHtml(customer.customerLabel)}</td><td><code class="deviceReference">${escapeHtml(customer.deviceId || customer.deviceRef || '—')}</code></td><td>${escapeHtml(customer.portalMac || '—')}</td><td>${escapeHtml(customer.platform || '—')}</td><td>${portalControl(customer)}</td><td><span class="tag ${customer.licenseState === 'active' ? 'on' : 'off'}">${escapeHtml(licenseStatusLabel[customer.licenseState] || 'Unknown')}</span><br>${escapeHtml(formatDate(customer.licenseExpiresAt))}</td><td>${escapeHtml(formatDate(customer.portalExpiresAt))}</td><td>${customer.lastSyncedAt ? escapeHtml(new Date(customer.lastSyncedAt).toLocaleString()) : 'Never'}</td><td>${renewalControl(customer)}</td></tr>`).join('') || '<tr><td colspan="9">No customer devices assigned yet</td></tr>';
  $('customerCards').innerHTML = data.customers.map(customer => `<article class="customerCard"><div class="customerCardHead"><div><b>${escapeHtml(customer.customerLabel)}</b><small>${escapeHtml(customer.platform || 'Device')}</small></div><span class="tag ${customer.licenseState === 'active' ? 'on' : 'off'}">${escapeHtml(licenseStatusLabel[customer.licenseState] || 'Unknown')}</span></div><p class="customerCardExpiry">App license until <b>${escapeHtml(formatDate(customer.licenseExpiresAt))}</b></p><div class="cardField"><span>Portal for this customer</span>${portalControl(customer)}</div><details class="accountDetails"><summary>Device details</summary><div class="detailGrid"><span>Device ID</span><code>${escapeHtml(customer.deviceId || customer.deviceRef || '—')}</code><span>Portal MAC</span><code>${escapeHtml(customer.portalMac || '—')}</code><span>Portal expiry</span><b>${escapeHtml(formatDate(customer.portalExpiresAt))}</b><span>Last sync</span><b>${escapeHtml(formatDateTime(customer.lastSyncedAt))}</b><span>License grace</span><b>${customer.licenseState === 'grace' ? `Until ${escapeHtml(formatDate(customer.graceUntil))}` : 'Seven days after expiry'}</b></div></details><div class="customerRenew">${renewalControl(customer)}</div></article>`).join('') || '<p class="muted">No customer devices assigned yet.</p>';
  const handleCustomerAction = async event => {
    const switchButton = event.target.closest('[data-switch-portal]');
    if (switchButton) {
      const deviceRef = switchButton.dataset.switchPortal;
      const profileId = switchButton.closest('tr, .customerCard')?.querySelector('[data-device-profile]')?.value;
      if (!profileId || profileId === data.customers.find(item => item.deviceRef === deviceRef)?.portalProfileId) return;
      switchButton.disabled = true;
      try { await switchDevicePortal({ deviceRef, profileId }); await refreshProviderDashboard(); $('providerError').textContent = 'Customer portal updated. The app receives it on its next sync.'; }
      catch (error) { $('providerError').textContent = friendlyError(error); switchButton.disabled = false; }
      return;
    }
    const button = event.target.closest('[data-renew-device]'); if (!button) return;
    const years = Number(button.closest('tr, .customerCard')?.querySelector('[data-renew-years]')?.value);
    if (!Number.isSafeInteger(years) || years < 1 || years > 10) return;
    if (!confirm(`Renew ${customerLabelForDevice(button.dataset.renewDevice, data.customers)} for ${years} year${years === 1 ? '' : 's'} using ${years} credit${years === 1 ? '' : 's'}?`)) return;
    button.disabled = true;
    try { const result = (await renewDeviceLicense({ deviceRef: button.dataset.renewDevice, years })).data; await refreshDashboard(); $('providerError').textContent = `License renewed until ${new Date(result.expiresAt).toLocaleDateString()}. ${result.remainingCredits} credits remain.`; }
    catch (error) { $('providerError').textContent = friendlyError(error); button.disabled = false; }
  };
  $('customersBody').onclick = $('customerCards').onclick = handleCustomerAction;
}

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault(); $('loginError').textContent = '';
  try { await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value); }
  catch(error) { $('loginError').textContent = friendlyError(error); }
});
$('logout').addEventListener('click', () => signOut(auth));
$('showMoreKeys').addEventListener('click', () => { showAllAdminKeys = !showAllAdminKeys; renderAdminKeys(); });
$('showMorePartnerLicenses').addEventListener('click', () => { showAllPartnerLicenses = !showAllPartnerLicenses; renderPartnerLicenses(); });
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
  $('pairingHelp').textContent = `Enter the short-lived code shown in the customer's app. Choose 1–10 years; each year uses 1 credit. Re-pairing an already licensed device changes its assignment without charging again.`;
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
  $('pairingHelp').textContent = `Choose the active partner that will own this customer, then enter the short-lived code from the customer's app. A new license uses 1 credit per year; reassigning an already licensed device does not charge again.`;
  $('pairingResult').textContent = '';
  setVisible('adminPairingOwnerField', true);
  openDialog('pairCustomerDialog');
});
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
      ? `${data.partner.displayName} has ${data.partner.credits} credits. The selected 1–10 year term will be deducted from this account when a new customer license is activated.`
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
    const years = Number($('durationYears').value);
    const payload = { pairingCode, profileId, customerLabel: $('customerLabel').value.trim(), durationYears: years };
    if (isAdmin) payload.partnerUid = partnerUid;
    const result = (await completePairing(payload)).data;
    const ownerName = result.ownerName || actor?.displayName || actor?.role || 'Partner';
    const summary = result.existingLicense
      ? `${ownerName}: existing license kept; no credits deducted. Balance remains ${result.remainingCredits} credits.`
      : `${years}-year customer license activated. ${result.creditsUsed} credits deducted from ${ownerName}; new balance: ${result.remainingCredits}.`;
    $('pairingForm').reset();
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
