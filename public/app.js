import { auth, functions } from './firebase-config.js';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';

const $ = id => document.getElementById(id);
const listDashboard = httpsCallable(functions, 'adminListDashboard');
const createKey = httpsCallable(functions, 'adminCreateKey');
const setKeyStatus = httpsCallable(functions, 'adminSetKeyStatus');
const setVersionRules = httpsCallable(functions, 'adminSetVersionRules');
const listPartnerDashboard = httpsCallable(functions, 'partnerListDashboard');
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
const adjustPartnerCredits = httpsCallable(functions, 'adminAdjustPartnerCredits');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const setVisible = (id, visible) => $(id).classList.toggle('hidden', !visible);
function friendlyError(error) { return error?.message?.replace(/^Firebase:\s*/,'') || 'Something went wrong. Please retry.'; }
let activeAdminTab = 'keys';
let currentPartnerData = null;
let currentPartnerActor = null;
let transferTarget = null;
let editingProfile = null;
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
const adminViews = {
  keys: ['keysPanel'],
  overview: ['statsPanel', 'devicesPanel'],
  partners: ['partnerPanel', 'partnerLimitsPanel'],
  customers: ['adminCustomersPanel']
};
function showAdminTab(tab) {
  if (!adminViews[tab]) return;
  activeAdminTab = tab;
  for (const [name, ids] of Object.entries(adminViews)) {
    for (const id of ids) setVisible(id, name === tab);
  }
  document.querySelectorAll('[data-admin-tab]').forEach(button => {
    const selected = button.dataset.adminTab === tab;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-current', selected ? 'page' : 'false');
  });
}
document.querySelectorAll('[data-admin-tab]').forEach(button => button.addEventListener('click', () => {
  showAdminTab(button.dataset.adminTab);
  if (activeAdminTab === 'customers') loadAdminCustomers();
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
  setVisible('adminNav', actor.role === 'admin');
  setVisible('partnerPanel', actor.role !== 'provider');
  setVisible('providerPanel', actor.role !== 'admin');
  if (actor.role === 'admin') showAdminTab(activeAdminTab);
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
  const roleOptions = account => roleChoices.map(role => `<option value="${role}" ${role === account.role ? 'selected' : ''}>${role}</option>`).join('');
  const parentOptions = account => parentChoices(account.role, account.uid).map(parent => `<option value="${escapeHtml(parent.uid)}" ${parent.uid === account.parentUid ? 'selected' : ''}>${escapeHtml(parent.displayName)} · ${parent.role}</option>`).join('');
  const canRoleChange = account => (actor.role === 'admin' && roleChoices.includes(account.role)) || (actor.role === 'distributor' && account.role !== 'distributor');
  const manage = account => {
    const canTransfer = (actor.role === 'distributor' && account.role === 'reseller') || (actor.role === 'reseller' && account.role === 'provider');
    return `<div class="accountActions">${canTransfer ? `<button class="textButton" data-partner-action="transfer" data-uid="${escapeHtml(account.uid)}">Transfer credits</button>` : ''}${actor.role === 'admin' ? `<button class="textButton" data-partner-action="adjust" data-uid="${escapeHtml(account.uid)}">Adjust credits</button>` : ''}${canRoleChange(account) ? `<details class="roleEditor"><summary>Change role</summary><label>Role<select data-role-for="${escapeHtml(account.uid)}">${roleOptions(account)}</select></label><label>Parent<select data-parent-for="${escapeHtml(account.uid)}">${parentOptions(account)}</select></label><button class="ghost small" data-partner-action="role" data-uid="${escapeHtml(account.uid)}">Save role</button></details>` : ''}</div>`;
  };
  const details = account => {
    const events = (partnerData.recentActivity || []).filter(item => item.fromUid === account.uid || item.toUid === account.uid || item.actorUid === account.uid).slice(0, 8);
    const activity = events.map(item => `<li>${escapeHtml(activityLabel(item.type))}${item.durationYears ? ` · ${item.durationYears} year${item.durationYears === 1 ? '' : 's'}` : ''} · ${item.amount} credit${item.amount === 1 ? '' : 's'} · ${escapeHtml(item.fromName)} → ${escapeHtml(item.toName)} <small>${escapeHtml(formatDateTime(item.createdAt))}</small></li>`).join('') || '<li>No recent account activity.</li>';
    return `<details class="accountDetails"><summary>Account details & activity</summary><div class="detailGrid"><span>Email</span><b>${escapeHtml(account.email || '—')}</b><span>Parent</span><b>${escapeHtml(account.parentName || 'Admin')}${account.parentUid ? ` · ${escapeHtml(account.parentUid)}` : ''}</b><span>Created by</span><b>${escapeHtml(account.createdByName || '—')}</b><span>Creator role</span><b>${escapeHtml(account.createdByRole || '—')}</b><span>Creator email</span><b>${escapeHtml(account.createdByEmail || '—')}</b><span>Creator ID</span><code>${escapeHtml(account.createdByUid || '—')}</code><span>Created</span><b>${escapeHtml(formatDateTime(account.createdAt))}</b><span>Account ID</span><code>${escapeHtml(account.uid)}</code></div><ul class="activityList">${activity}</ul></details>`;
  };
  const recentEvents = partnerData.recentActivity || [];
  $('partnerActivity').innerHTML = recentEvents.map(item => `<li>${escapeHtml(activityLabel(item.type))}${item.durationYears ? ` · ${item.durationYears} year${item.durationYears === 1 ? '' : 's'}` : ''} · ${item.amount} credit${item.amount === 1 ? '' : 's'} · ${escapeHtml(item.fromName)} → ${escapeHtml(item.toName)} · by ${escapeHtml(item.actorName)} <small>${escapeHtml(formatDateTime(item.createdAt))}</small></li>`).join('');
  setVisible('partnerActivityEmpty', recentEvents.length === 0);
  $('partnerActivity').classList.toggle('hidden', recentEvents.length === 0);
  $('accountsBody').innerHTML = allAccounts.map(a => `<tr><td><b>${escapeHtml(a.displayName)}</b><br><small>${escapeHtml(a.email)}</small></td><td>${escapeHtml(a.role)}</td><td>${escapeHtml(a.parentName || 'Admin')}</td><td>${a.credits}</td><td><span class="tag ${a.active?'on':'off'}">${a.active?'Active':'Disabled'}</span></td><td>${manage(a)}${details(a)}</td></tr>`).join('') || '<tr><td colspan="6">No accounts to show</td></tr>';
  $('accountsCards').innerHTML = allAccounts.map(a => `<article class="accountCard"><div class="accountCardHead"><div><b>${escapeHtml(a.displayName)}</b><small>${escapeHtml(a.role)} · under ${escapeHtml(a.parentName || 'Admin')}</small></div><strong>${a.credits} <small>credits</small></strong></div><div class="accountCardStatus"><span class="tag ${a.active?'on':'off'}">${a.active?'Active':'Disabled'}</span><small>Created ${escapeHtml(formatDate(a.createdAt))}</small></div>${details(a)}${manage(a)}</article>`).join('') || '<p class="muted">No accounts to show.</p>';
  $('accountsBody').onclick = $('accountsCards').onclick = async event => {
    const button = event.target.closest('[data-partner-action]'); if (!button) return;
    const account = partnerData.accounts.find(a => a.uid === button.dataset.uid); if (!account) return;
    try {
      if (button.dataset.partnerAction === 'transfer') {
        transferTarget = account;
        $('creditTransferRecipient').textContent = `${account.displayName} · ${account.role}`;
        $('creditTransferAmount').value = actor.role === 'reseller' ? '20' : '';
        $('creditTransferAmount').max = String(actor.credits);
        $('creditTransferAvailable').textContent = `Available balance: ${actor.credits} credits. The transfer and ledger entry are saved together.`;
        $('creditTransferError').textContent = '';
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
    const role = event.target.closest('[data-role-for]'); if (!role) return;
    const uid = role.dataset.roleFor, row = role.closest('tr') || role.closest('.accountCard');
    const parent = row.querySelector(`[data-parent-for="${CSS.escape(uid)}"]`);
    if (role.value === 'distributor') parent.innerHTML = '<option value="">Admin</option>';
    else {
      const required = role.value === 'reseller' ? 'distributor' : 'reseller';
      const candidates = parentChoices(role.value, uid);
      parent.innerHTML = candidates.map(item => `<option value="${escapeHtml(item.uid)}" ${item.uid === partnerData.accounts.find(a=>a.uid===uid)?.parentUid ? 'selected' : ''}>${escapeHtml(item.displayName)} · ${item.role}</option>`).join('');
    }
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
  $('keysBody').innerHTML = result.keys.map(k => `<tr><td>${escapeHtml(k.label || '—')}<details class="accountDetails"><summary>Key creator details</summary><div class="detailGrid"><span>Created by</span><b>${escapeHtml(k.createdByName || (k.createdBy ? 'Admin (name unavailable)' : 'Unknown legacy creator'))}</b><span>Role</span><b>${escapeHtml(k.createdByRole || '—')}</b><span>Email</span><b>${escapeHtml(k.createdByEmail || '—')}</b><span>Account ID</span><code>${escapeHtml(k.createdBy || '—')}</code><span>Created</span><b>${escapeHtml(formatDateTime(k.createdAt))}</b></div></details></td><td>${k.deviceCount} / ${k.deviceLimit}</td><td>${k.expiresAt ? new Date(k.expiresAt).toLocaleString() : 'Never'}</td><td><span class="tag ${k.expired||!k.active?'off':'on'}">${k.expired?'Expired':k.active?'Active':'Disabled'}</span></td><td><button class="textButton" data-key="${escapeHtml(k.id)}" data-active="${k.active}">${k.active?'Disable':'Enable'}</button></td></tr>`).join('') || '<tr><td colspan="5">No keys yet</td></tr>';
  $('devicesBody').innerHTML = result.devices.map(d => `<tr><td>${escapeHtml(d.platform)}</td><td>${escapeHtml(d.appVersion)}</td><td>${escapeHtml(d.portalHost || '—')}</td><td>${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : '—'}</td></tr>`).join('') || '<tr><td colspan="4">No registered devices yet</td></tr>';
  for (const id of ['androidMinimumVersion','windowsMinimumVersion','androidUpdateUrl','windowsUpdateUrl']) $(id).value = result.settings[id] || '';
  document.querySelectorAll('[data-key]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await setKeyStatus({ keyId:button.dataset.key, active:button.dataset.active !== 'true' }); await refreshDashboard(); }
    catch(error) { alert(friendlyError(error)); button.disabled = false; }
  }));
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
  $('providerSummary').textContent = `${data.account.displayName || data.account.email} · ${data.account.credits} credits`;
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
  const statusLabel = { active: 'Active', grace: 'Grace period', expired: 'Expired', disabled: 'Disabled' };
  const portalControl = customer => `<div class="devicePortalControl"><select data-device-profile aria-label="Active portal for ${escapeHtml(customer.customerLabel)}"><option value="">Choose active portal</option>${activeProfiles.map(profile => `<option value="${escapeHtml(profile.id)}" ${profile.id === customer.portalProfileId ? 'selected' : ''}>${escapeHtml(profile.name)} · ${escapeHtml(profile.host)}</option>`).join('')}</select><button class="textButton" data-switch-portal="${escapeHtml(customer.deviceRef)}" ${activeProfiles.length ? '' : 'disabled'}>Switch portal</button><small>Current: ${escapeHtml(customer.portalName)}${customer.portalActive ? '' : ' · inactive'}</small></div>`;
  const renewalControl = customer => customer.active && customer.licenseState !== 'disabled'
    ? `<div class="renewControls"><select data-renew-years aria-label="Renewal term for ${escapeHtml(customer.customerLabel)}">${licenseYearOptions()}</select><button class="textButton" data-renew-device="${escapeHtml(customer.deviceRef)}">Renew</button></div>` : '—';
  $('customersBody').innerHTML = data.customers.map(customer => `<tr><td>${escapeHtml(customer.customerLabel)}</td><td><code class="deviceReference">${escapeHtml(customer.deviceId || customer.deviceRef || '—')}</code></td><td>${escapeHtml(customer.portalMac || '—')}</td><td>${escapeHtml(customer.platform || '—')}</td><td>${portalControl(customer)}</td><td><span class="tag ${customer.licenseState === 'active' ? 'on' : 'off'}">${escapeHtml(statusLabel[customer.licenseState] || 'Unknown')}</span><br>${escapeHtml(formatDate(customer.licenseExpiresAt))}</td><td>${escapeHtml(formatDate(customer.portalExpiresAt))}</td><td>${customer.lastSyncedAt ? escapeHtml(new Date(customer.lastSyncedAt).toLocaleString()) : 'Never'}</td><td>${renewalControl(customer)}</td></tr>`).join('') || '<tr><td colspan="9">No customer devices assigned yet</td></tr>';
  $('customerCards').innerHTML = data.customers.map(customer => `<article class="customerCard"><div class="customerCardHead"><div><b>${escapeHtml(customer.customerLabel)}</b><small>${escapeHtml(customer.platform || 'Device')}</small></div><span class="tag ${customer.licenseState === 'active' ? 'on' : 'off'}">${escapeHtml(statusLabel[customer.licenseState] || 'Unknown')}</span></div><p class="customerCardExpiry">App license until <b>${escapeHtml(formatDate(customer.licenseExpiresAt))}</b></p><div class="cardField"><span>Portal for this customer</span>${portalControl(customer)}</div><details class="accountDetails"><summary>Device details</summary><div class="detailGrid"><span>Device ID</span><code>${escapeHtml(customer.deviceId || customer.deviceRef || '—')}</code><span>Portal MAC</span><code>${escapeHtml(customer.portalMac || '—')}</code><span>Portal expiry</span><b>${escapeHtml(formatDate(customer.portalExpiresAt))}</b><span>Last sync</span><b>${escapeHtml(formatDateTime(customer.lastSyncedAt))}</b><span>License grace</span><b>${customer.licenseState === 'grace' ? `Until ${escapeHtml(formatDate(customer.graceUntil))}` : 'Seven days after expiry'}</b></div></details><div class="customerRenew">${renewalControl(customer)}</div></article>`).join('') || '<p class="muted">No customer devices assigned yet.</p>';
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
$('refreshPartner').addEventListener('click', () => refreshDashboard().catch(e => alert(friendlyError(e))));
$('createPartner').addEventListener('click', () => {
  if (!currentPartnerActor || !currentPartnerData) return;
  const actor = currentPartnerActor, limits = currentPartnerData.limits || {};
  const role = actor.role === 'admin' ? 'distributor' : actor.role === 'distributor' ? 'reseller' : 'provider';
  const minimum = actor.role === 'admin' ? Number(limits.distributorMinCredits || 500) : actor.role === 'reseller' ? Number(limits.resellerToProviderMin || 20) : 0;
  const maximum = actor.role === 'admin' ? null : actor.role === 'distributor' ? Math.min(actor.credits, Number(limits.distributorToResellerMax || 250)) : actor.credits;
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
  const amount = Number($('creditTransferAmount').value), available = Number(currentPartnerActor?.credits || 0);
  if (!transferTarget || !Number.isSafeInteger(amount) || amount < 1 || amount > available) {
    $('creditTransferError').textContent = 'Enter a whole-number amount no greater than your available balance.'; return;
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
  const pairingCode = $('pairingCode').value.trim().toUpperCase(), profileId = $('pairingProfile').value;
  if (!profileId) { $('pairingResult').textContent = 'Create an active portal profile first.'; return; }
  try {
    const result = (await completePairing({ pairingCode, profileId, customerLabel: $('customerLabel').value.trim(), durationYears: Number($('durationYears').value) })).data;
    const years = Number($('durationYears').value);
    const summary = result.existingLicense ? 'Device portal assignment updated; existing license retained.' : `Device paired for ${years} year${years === 1 ? '' : 's'}. ${years} credit${years === 1 ? '' : 's'} used; ${result.remainingCredits} credits remain.`;
    $('pairingResult').innerHTML = `${escapeHtml(summary)}<br>Device ID: <code class="deviceReference">${escapeHtml(result.deviceId || '—')}</code><br>Portal MAC: <code>${escapeHtml(result.portalMac || 'Not provided by this app')}</code>`;
    $('pairingForm').reset(); await refreshProviderDashboard(); await refreshDashboard();
  } catch (error) { $('pairingResult').textContent = friendlyError(error); }
});

onAuthStateChanged(auth, async user => {
  setVisible('login', !user); setVisible('dashboard', !!user); setVisible('logout', !!user);
  if (user) { try { await refreshDashboard(); } catch(error) { $('dashboardError').textContent = friendlyError(error); } }
});
