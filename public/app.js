import { auth, functions } from './firebase-config.js';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-functions.js';

const $ = id => document.getElementById(id);
const listDashboard = httpsCallable(functions, 'adminListDashboard');
const createKey = httpsCallable(functions, 'adminCreateKey');
const setKeyStatus = httpsCallable(functions, 'adminSetKeyStatus');
const setVersionRules = httpsCallable(functions, 'adminSetVersionRules');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const setVisible = (id, visible) => $(id).classList.toggle('hidden', !visible);
function friendlyError(error) { return error?.message?.replace(/^Firebase:\s*/,'') || 'Something went wrong. Please retry.'; }

async function refreshDashboard() {
  $('dashboardError').textContent = '';
  const result = (await listDashboard()).data;
  $('deviceCount').textContent = result.activeDevices;
  $('keyCount').textContent = result.activeKeys;
  $('androidCount').textContent = result.platformCounts.android;
  $('windowsCount').textContent = result.platformCounts.windows;
  $('keysBody').innerHTML = result.keys.map(k => `<tr><td>${escapeHtml(k.label || '—')}</td><td>${k.deviceCount} / ${k.deviceLimit}</td><td><span class="tag ${k.active?'on':'off'}">${k.active?'Active':'Disabled'}</span></td><td><button class="textButton" data-key="${escapeHtml(k.id)}" data-active="${k.active}">${k.active?'Disable':'Enable'}</button></td></tr>`).join('') || '<tr><td colspan="4">No keys yet</td></tr>';
  $('devicesBody').innerHTML = result.devices.map(d => `<tr><td>${escapeHtml(d.platform)}</td><td>${escapeHtml(d.appVersion)}</td><td>${escapeHtml(d.portalHost || '—')}</td><td>${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : '—'}</td></tr>`).join('') || '<tr><td colspan="4">No registered devices yet</td></tr>';
  for (const id of ['androidMinimumVersion','windowsMinimumVersion','androidUpdateUrl','windowsUpdateUrl']) $(id).value = result.settings[id] || '';
  document.querySelectorAll('[data-key]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await setKeyStatus({ keyId:button.dataset.key, active:button.dataset.active !== 'true' }); await refreshDashboard(); }
    catch(error) { alert(friendlyError(error)); button.disabled = false; }
  }));
}

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault(); $('loginError').textContent = '';
  try { await signInWithEmailAndPassword(auth, $('email').value.trim(), $('password').value); }
  catch(error) { $('loginError').textContent = friendlyError(error); }
});
$('logout').addEventListener('click', () => signOut(auth));
$('refresh').addEventListener('click', () => refreshDashboard().catch(e => alert(friendlyError(e))));
$('newKey').addEventListener('click', async () => {
  const answer = prompt('Key label (optional):'); if (answer === null) return;
  const limit = Number(prompt('Maximum devices for this key?', '1') || 1);
  try {
    const result = (await createKey({ label:answer, deviceLimit:limit })).data;
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

onAuthStateChanged(auth, async user => {
  setVisible('login', !user); setVisible('dashboard', !!user); setVisible('logout', !!user);
  if (user) { try { await refreshDashboard(); } catch(error) { $('dashboardError').textContent = friendlyError(error); } }
});
