const $ = (id) => document.getElementById(id);
let token = sessionStorage.getItem('stb_admin_key') || '';
async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'content-type': 'application/json', 'x-admin-key': token, ...(options.headers || {}) } });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Request failed'); return data;
}
function showDashboard(show) { $('login').classList.toggle('hidden', show); $('dashboard').classList.toggle('hidden', !show); $('logout').classList.toggle('hidden', !show); }
function escapeHtml(s='') { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function load() {
  const [summary, keys] = await Promise.all([api('/admin/api/summary'), api('/admin/api/keys')]);
  $('deviceCount').textContent = summary.activeDevices; $('keyCount').textContent = summary.activeKeys;
  const count = Object.fromEntries(summary.platforms.map(x => [x.platform, x.count])); $('androidCount').textContent = count.android || 0; $('windowsCount').textContent = count.windows || 0;
  $('keysBody').innerHTML = keys.map(k => `<tr><td>${escapeHtml(k.label || '—')}</td><td>${k.deviceCount} / ${k.deviceLimit}</td><td><span class="tag ${k.active?'on':'off'}">${k.active?'Active':'Disabled'}</span></td><td><button class="textButton" data-key="${escapeHtml(k.id)}" data-active="${k.active}">${k.active?'Disable':'Enable'}</button></td></tr>`).join('') || '<tr><td colspan="4">No keys yet</td></tr>';
  $('devicesBody').innerHTML = summary.recent.map(d => `<tr><td>${escapeHtml(d.platform)}</td><td>${escapeHtml(d.appVersion)}</td><td>${escapeHtml(d.portalHost || '—')}</td><td>${new Date(d.lastSeen).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="4">No registered devices yet</td></tr>';
  for (const [id, val] of Object.entries(summary.settings)) { if ($(id)) $(id).value = val; }
  document.querySelectorAll('[data-key]').forEach(button => button.addEventListener('click', async () => { try { await api(`/admin/api/keys/${button.dataset.key}`, { method:'PATCH', body:JSON.stringify({active:button.dataset.active !== '1'}) }); await load(); } catch(e) { alert(e.message); } }));
}
async function login() { try { token = $('adminKey').value; await api('/admin/api/summary'); sessionStorage.setItem('stb_admin_key', token); $('loginError').textContent=''; showDashboard(true); await load(); } catch(e) { token=''; $('loginError').textContent=e.message; } }
$('loginForm').addEventListener('submit', e => { e.preventDefault(); login(); });
$('logout').addEventListener('click', () => { token=''; sessionStorage.removeItem('stb_admin_key'); showDashboard(false); });
$('refresh').addEventListener('click', () => load().catch(e => alert(e.message)));
$('newKey').addEventListener('click', async () => { const answer = prompt('Key label (optional):'); if (answer === null) return; const label = answer; const deviceLimit = Number(prompt('Maximum devices for this key?', '1') || 1); try { const data = await api('/admin/api/keys', { method:'POST', body:JSON.stringify({label,deviceLimit}) }); $('newKeyResult').innerHTML = `Copy this key now; it is only displayed once:<br><code>${escapeHtml(data.key)}</code>`; $('newKeyResult').classList.remove('hidden'); await load(); } catch(e) { alert(e.message); } });
$('versionsForm').addEventListener('submit', async e => { e.preventDefault(); try { const body = {min_android_version:$('androidMin').value,android_update_url:$('androidUrl').value,min_windows_version:$('windowsMin').value,windows_update_url:$('windowsUrl').value}; await api('/admin/api/settings',{method:'PUT',body:JSON.stringify(body)}); alert('Version rules saved.'); } catch(err) { alert(err.message); } });
if (token) { showDashboard(true); load().catch(() => { token=''; sessionStorage.removeItem('stb_admin_key'); showDashboard(false); }); }
