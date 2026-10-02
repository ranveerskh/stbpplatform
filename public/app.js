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
const adminProviderDashboard = httpsCallable(functions, 'adminProviderDashboard');
const adjustPartnerCredits = httpsCallable(functions, 'adminAdjustPartnerCredits');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const setVisible = (id, visible) => $(id).classList.toggle('hidden', !visible);
function friendlyError(error) { return error?.message?.replace(/^Firebase:\s*/,'') || 'Something went wrong. Please retry.'; }

async function refreshDashboard() {
  $('dashboardError').textContent = '';
  const partnerData = (await listPartnerDashboard()).data;
  const actor = partnerData.account;
  $('accountHeading').textContent = actor.role === 'admin' ? 'All partner accounts' : 'Your accounts';
  $('accountSummary').textContent = `${actor.displayName || actor.email || actor.role} · ${actor.role} · ${actor.credits ?? 0} credits`;
  const canCreate = ['admin','distributor','reseller'].includes(actor.role);
  $('createPartner').classList.toggle('hidden', !canCreate);
  $('createPartner').textContent = actor.role === 'admin' ? 'Create distributor' : actor.role === 'distributor' ? 'Create reseller' : 'Create provider';
  $('adminTools').classList.toggle('hidden', actor.role !== 'admin');
  setVisible('partnerPanel', actor.role !== 'provider');
  setVisible('providerPanel', actor.role === 'provider');
  if (actor.role === 'provider') await refreshProviderDashboard();
  if (actor.role === 'admin' && partnerData.limits) {
    for (const id of ['distributorMinCredits','distributorToResellerMax','resellerToProviderMin']) $(id).value = partnerData.limits[id];
  }
  const rows = partnerData.accounts.map(a => {
    const actions = [];
    if (['distributor','reseller'].includes(actor.role) && ((actor.role === 'distributor' && a.role === 'reseller') || (actor.role === 'reseller' && a.role === 'provider'))) actions.push(`<button class="textButton" data-partner-action="transfer" data-uid="${escapeHtml(a.uid)}">Transfer</button>`);
    if (actor.role === 'admin') actions.push(`<button class="textButton" data-partner-action="adjust" data-uid="${escapeHtml(a.uid)}">Adjust credits</button>`);
    if (actor.role === 'admin' || actor.role === 'distributor') actions.push(`<button class="textButton" data-partner-action="role" data-uid="${escapeHtml(a.uid)}">Change role</button>`);
    return `<tr><td>${escapeHtml(a.displayName)}</td><td>${escapeHtml(a.email)}</td><td>${escapeHtml(a.role)}</td><td>${escapeHtml(a.parentName || '—')}</td><td>${a.credits}</td><td><span class="tag ${a.active?'on':'off'}">${a.active?'Active':'Disabled'}</span></td><td>${actions.join(' ') || '—'}</td></tr>`;
  });
  $('accountsBody').innerHTML = rows.join('') || '<tr><td colspan="7">No accounts to show</td></tr>';
  $('accountsBody').onclick = async event => {
    const button = event.target.closest('[data-partner-action]'); if (!button) return;
    const account = partnerData.accounts.find(a => a.uid === button.dataset.uid); if (!account) return;
    try {
      if (button.dataset.partnerAction === 'transfer') {
        const amount = Number(prompt(`Credits to transfer to ${account.displayName}:`, actor.role === 'reseller' ? '20' : '')); if (!Number.isSafeInteger(amount) || amount < 1) return;
        await transferCredits({ targetUid: account.uid, amount });
      } else if (button.dataset.partnerAction === 'adjust' && actor.role === 'admin') {
        const delta = Number(prompt(`Credit adjustment for ${account.displayName}. Use a positive number to add or a negative number to remove:`, '500'));
        if (!Number.isSafeInteger(delta) || delta === 0) return;
        await adjustPartnerCredits({ targetUid: account.uid, delta });
      } else {
        const newRole = prompt(`New role for ${account.displayName} (distributor, reseller, provider):`, account.role)?.trim().toLowerCase(); if (!newRole) return;
        const parentInput = newRole === 'distributor' ? '' : prompt('Parent account UID (leave blank to keep current parent):', account.parentUid || '');
        if (parentInput === null) return;
        await changePartnerRole({ targetUid: account.uid, newRole, newParentUid: parentInput || undefined });
      }
      await refreshDashboard();
    } catch(error) { alert(friendlyError(error)); }
  };

  if (actor.role !== 'admin') return;
  const result = (await listDashboard()).data;
  await refreshAdminProviderDashboard();
  $('deviceCount').textContent = result.activeDevices;
  $('keyCount').textContent = result.activeKeys;
  $('totalAppDevices').textContent = result.appUsage?.totalDevices ?? 0;
  $('active24h').textContent = result.appUsage?.active24h ?? 0;
  $('active7d').textContent = result.appUsage?.active7d ?? 0;
  $('active30d').textContent = result.appUsage?.active30d ?? 0;
  $('androidCount').textContent = result.platformCounts.android;
  $('windowsCount').textContent = result.platformCounts.windows;
  $('keysBody').innerHTML = result.keys.map(k => `<tr><td>${escapeHtml(k.label || '—')}</td><td>${k.deviceCount} / ${k.deviceLimit}</td><td>${k.expiresAt ? new Date(k.expiresAt).toLocaleString() : 'Never'}</td><td><span class="tag ${k.expired||!k.active?'off':'on'}">${k.expired?'Expired':k.active?'Active':'Disabled'}</span></td><td><button class="textButton" data-key="${escapeHtml(k.id)}" data-active="${k.active}">${k.active?'Disable':'Enable'}</button></td></tr>`).join('') || '<tr><td colspan="5">No keys yet</td></tr>';
  $('devicesBody').innerHTML = result.devices.map(d => `<tr><td>${escapeHtml(d.platform)}</td><td>${escapeHtml(d.appVersion)}</td><td>${escapeHtml(d.portalHost || '—')}</td><td>${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : '—'}</td></tr>`).join('') || '<tr><td colspan="4">No registered devices yet</td></tr>';
  for (const id of ['androidMinimumVersion','windowsMinimumVersion','androidUpdateUrl','windowsUpdateUrl']) $(id).value = result.settings[id] || '';
  document.querySelectorAll('[data-key]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await setKeyStatus({ keyId:button.dataset.key, active:button.dataset.active !== 'true' }); await refreshDashboard(); }
    catch(error) { alert(friendlyError(error)); button.disabled = false; }
  }));
}

async function refreshAdminProviderDashboard() {
  const data = (await adminProviderDashboard()).data;
  $('adminCustomerSummary').textContent = `${data.customers.length} assigned customer device${data.customers.length === 1 ? '' : 's'}${data.hasMore ? ' · showing the 500 most recently updated' : ''}`;
  const labels = { active: 'Active', grace: 'Grace period', expired: 'Expired', disabled: 'Disabled' };
  $('adminCustomersBody').innerHTML = data.customers.map(customer => `<tr><td>${escapeHtml(customer.customerLabel)}</td><td>${escapeHtml(customer.providerName)}<br><small>${escapeHtml(customer.providerEmail)}</small></td><td>${escapeHtml(customer.platform || '—')}</td><td>${escapeHtml(customer.portalName)} · ${escapeHtml(customer.portalHost || 'host unavailable')}${customer.portalActive ? '' : ' · disabled'}</td><td><span class="tag ${customer.licenseState === 'active' ? 'on' : 'off'}">${escapeHtml(labels[customer.licenseState] || 'Unknown')}</span><br>${escapeHtml(formatDate(customer.licenseExpiresAt))}</td><td>${escapeHtml(formatDate(customer.portalExpiresAt))}</td><td>${customer.lastSyncedAt ? escapeHtml(new Date(customer.lastSyncedAt).toLocaleString()) : 'Never'}</td><td><button class="textButton" data-admin-license="${escapeHtml(customer.licenseId)}" data-active="${customer.active}">${customer.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('') || '<tr><td colspan="8">No provider-assigned customer devices yet</td></tr>';
  $('adminCustomersBody').onclick = async event => {
    const button = event.target.closest('[data-admin-license]'); if (!button) return;
    const active = button.dataset.active !== 'true';
    if (!confirm(`${active ? 'Enable' : 'Disable'} this customer app license?`)) return;
    button.disabled = true;
    try { await setKeyStatus({ keyId: button.dataset.adminLicense, active }); await refreshDashboard(); }
    catch (error) { alert(friendlyError(error)); button.disabled = false; }
  };
}

function formatDate(value) { return value ? new Date(value).toLocaleDateString() : 'Not set'; }
async function refreshProviderDashboard() {
  $('providerError').textContent = '';
  const data = (await providerDashboard()).data;
  $('providerSummary').textContent = `${data.account.displayName || data.account.email} · ${data.account.credits} credits`;
  const profileOptions = data.profiles.filter(profile => profile.active).map(profile => `<option value="${escapeHtml(profile.id)}">${escapeHtml(profile.name)} · ${escapeHtml(profile.host)}</option>`).join('');
  $('pairingProfile').innerHTML = profileOptions || '<option value="">Create an active portal profile first</option>';
  $('pairingProfile').disabled = !profileOptions;
  $('profilesList').innerHTML = data.profiles.map(profile => `<article class="profileItem"><div><b>${escapeHtml(profile.name)}</b><small>${escapeHtml(profile.host || 'Host unavailable')} · expires ${escapeHtml(formatDate(profile.expiresAt))} · revision ${profile.revision}</small></div><button class="textButton" data-profile-edit="${escapeHtml(profile.id)}">Edit</button></article>`).join('') || '<p class="muted">No portal profiles yet.</p>';
  $('profilesList').onclick = async event => {
    const button = event.target.closest('[data-profile-edit]'); if (!button) return;
    const profile = data.profiles.find(item => item.id === button.dataset.profileEdit); if (!profile) return;
    const portalUrl = prompt('Enter the updated authorized portal URL:', ''); if (portalUrl === null) return;
    const name = prompt('Profile name:', profile.name); if (name === null) return;
    const expiryText = prompt('Portal expiry in local time (YYYY-MM-DDTHH:mm), or blank if not known:', profile.expiresAt ? new Date(profile.expiresAt).toISOString().slice(0,16) : '');
    if (expiryText === null) return;
    const expiresAt = expiryText.trim() ? new Date(expiryText).getTime() : null;
    if (expiryText.trim() && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) { alert('Enter a future portal expiry date and time.'); return; }
    try { await updatePortalProfile({ profileId: profile.id, name: name.trim(), portalUrl: portalUrl.trim(), expiresAt }); await refreshProviderDashboard(); alert('Portal profile saved. Assigned apps receive it on their next sync.'); }
    catch (error) { alert(friendlyError(error)); }
  };
  const statusLabel = { active: 'Active', grace: 'Grace period', expired: 'Expired', disabled: 'Disabled' };
  $('customersBody').innerHTML = data.customers.map(customer => {
    const canRenew = customer.active && customer.licenseState !== 'disabled';
    return `<tr><td>${escapeHtml(customer.customerLabel)}</td><td>${escapeHtml(customer.platform || '—')}</td><td>${escapeHtml(customer.portalName)}${customer.portalActive ? '' : ' · disabled'}</td><td><span class="tag ${customer.licenseState === 'active' ? 'on' : 'off'}">${escapeHtml(statusLabel[customer.licenseState] || 'Unknown')}</span><br>${escapeHtml(formatDate(customer.licenseExpiresAt))}</td><td>${escapeHtml(formatDate(customer.portalExpiresAt))}</td><td>${customer.lastSyncedAt ? escapeHtml(new Date(customer.lastSyncedAt).toLocaleString()) : 'Never'}</td><td>${canRenew ? `<button class="textButton" data-renew-device="${escapeHtml(customer.deviceRef)}">Renew · 1 credit</button>` : '—'}</td></tr>`;
  }).join('') || '<tr><td colspan="7">No customer devices assigned yet</td></tr>';
  $('customersBody').onclick = async event => {
    const button = event.target.closest('[data-renew-device]'); if (!button) return;
    if (!confirm('Use 1 credit to renew this customer app license for 12 months?')) return;
    button.disabled = true;
    try { const result = (await renewDeviceLicense({ deviceRef: button.dataset.renewDevice })).data; alert(`License renewed until ${new Date(result.expiresAt).toLocaleDateString()}. ${result.remainingCredits} credits remain.`); await refreshProviderDashboard(); await refreshDashboard(); }
    catch (error) { alert(friendlyError(error)); button.disabled = false; }
  };
}

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault(); $('loginError').textContent = '';
  try { await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value); }
  catch(error) { $('loginError').textContent = friendlyError(error); }
});
$('logout').addEventListener('click', () => signOut(auth));
$('refreshPartner').addEventListener('click', () => refreshDashboard().catch(e => alert(friendlyError(e))));
$('createPartner').addEventListener('click', async () => {
  const result = await listPartnerDashboard().catch(error => { alert(friendlyError(error)); return null; });
  if (!result) return;
  const actor = result.data.account, displayName = prompt('Account name:')?.trim(); if (!displayName) return;
  const email = prompt('Account email:')?.trim(); if (!email) return;
  const defaultCredits = actor.role === 'admin' ? '500' : actor.role === 'distributor' ? '20' : '20';
  const credits = Number(prompt('Opening credit allocation:', defaultCredits));
  if (!Number.isSafeInteger(credits) || credits < 0) { alert('Enter a whole number of credits.'); return; }
  try {
    const callable = actor.role === 'admin' ? createDistributor : createPartnerChild;
    const payload = actor.role === 'admin' ? { displayName, email, credits } : { displayName, email, credits, role: actor.role === 'distributor' ? 'reseller' : 'provider' };
    const created = (await callable(payload)).data;
    $('accountResult').innerHTML = `Account created for ${escapeHtml(created.email)}. Set password using this one-time link:<br><a href="${escapeHtml(created.passwordResetLink)}" target="_blank" rel="noopener">Open password setup</a>`;
    setVisible('accountResult', true); await refreshDashboard();
  } catch(error) { alert(friendlyError(error)); }
});
$('refresh').addEventListener('click', () => refreshDashboard().catch(e => alert(friendlyError(e))));
$('refreshAdminCustomers').addEventListener('click', () => refreshAdminProviderDashboard().catch(e => alert(friendlyError(e))));
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
    const result = (await completePairing({ pairingCode, profileId, customerLabel: $('customerLabel').value.trim() })).data;
    $('pairingResult').textContent = result.existingLicense ? 'Device portal assignment updated; existing license retained.' : `Device paired. 1 credit used; ${result.remainingCredits} credits remain.`;
    $('pairingForm').reset(); await refreshProviderDashboard(); await refreshDashboard();
  } catch (error) { $('pairingResult').textContent = friendlyError(error); }
});

onAuthStateChanged(auth, async user => {
  setVisible('login', !user); setVisible('dashboard', !!user); setVisible('logout', !!user);
  if (user) { try { await refreshDashboard(); } catch(error) { $('dashboardError').textContent = friendlyError(error); } }
});
