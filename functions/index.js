const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { createHash, randomBytes } = require('node:crypto');

admin.initializeApp();
const db = admin.firestore();
const partnerFunctions = require('./partner-functions');
Object.assign(exports, partnerFunctions.callables);
const region = 'northamerica-northeast1';
const settingsRef = db.collection('platform').doc('settings');
const keysRef = db.collection('registrationKeys');
const hash = value => createHash('sha256').update(value).digest('hex');
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const fail = (code, message) => { throw new HttpsError(code, message); };
const text = (value, max = 100) => String(value || '').trim().slice(0, max);

function safeHost(value) {
  const raw = text(value, 2048);
  if (!raw) return '';
  try { return new URL(raw.includes('://') ? raw : `http://${raw}`).hostname.toLowerCase().slice(0, 253); }
  catch { return ''; }
}
function parts(value) {
  const m = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  return m ? m.slice(1, 4).map(Number) : null;
}
function outdated(version, minimum) {
  const a = parts(version), b = parts(minimum);
  if (!a || !b) return true;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
function versionInfo(platform, version, cfg) {
  const minimumVersion = cfg[`${platform}MinimumVersion`] || '1.0.0';
  return { platform, minimumVersion, updateRequired: outdated(version, minimumVersion), updateUrl: cfg[`${platform}UpdateUrl`] || '' };
}
function licenseInfo(data) {
  return { licenseLabel: text(data.label, 100) || 'STB Play license', licenseExpiresAt: data.expiresAt?.toDate?.().toISOString() || null,
    licenseExpired: !!data.expiresAt && data.expiresAt.toMillis() <= Date.now() };
}
async function recordAppUsage(deviceId, platform, appVersion) {
  const ref = db.collection('appDevices').doc(hash(deviceId));
  await db.runTransaction(async tx => {
    const old = await tx.get(ref);
    tx.set(ref, { platform, appVersion, firstSeen: old.exists ? old.data().firstSeen : stamp(), lastSeen: stamp(),
      deleteAt: admin.firestore.Timestamp.fromMillis(Date.now() + 365 * 24 * 60 * 60 * 1000), active: true }, { merge: true });
  });
}
function deviceDeleteAt() {
  return admin.firestore.Timestamp.fromMillis(Date.now() + 365 * 24 * 60 * 60 * 1000);
}
async function readSettings() {
  const snap = await settingsRef.get();
  return { androidMinimumVersion: '1.0.0', windowsMinimumVersion: '1.0.0', androidUpdateUrl: '', windowsUpdateUrl: '', ...(snap.exists ? snap.data() : {}) };
}
async function requireAdmin(request) {
  if (!request.auth?.uid) fail('unauthenticated', 'Sign in to continue.');
  const snap = await db.collection('admins').doc(request.auth.uid).get();
  // Existing admin records predate the optional role field. Preserve their access.
  const data = snap.data();
  if (!snap.exists || data.active === false || (data.role && data.role !== 'admin')) fail('permission-denied', 'Admin access is required.');
}

exports.adminCreateKey = onCall({ region }, async request => {
  await requireAdmin(request);
  const label = text(request.data?.label, 100);
  const deviceLimit = Math.max(1, Math.min(100, Number(request.data?.deviceLimit) || 1));
  const expiryInput = request.data?.expiresAt;
  const expiresAtMillis = expiryInput == null || expiryInput === '' ? null : Number(expiryInput);
  if (expiresAtMillis !== null && (!Number.isFinite(expiresAtMillis) || expiresAtMillis <= Date.now())) fail('invalid-argument', 'Expiry must be a future date and time.');
  const key = `STB-${randomBytes(16).toString('hex').toUpperCase()}`;
  await keysRef.doc(hash(key)).set({ label, keyHint: key.slice(-4), active: true, deviceLimit,
    expiresAt: expiresAtMillis === null ? null : admin.firestore.Timestamp.fromMillis(expiresAtMillis), createdAt: stamp() });
  return { key, keyHint: key.slice(-4), deviceLimit, expiresAt: expiresAtMillis };
});

exports.adminListDashboard = onCall({ region }, async request => {
  await requireAdmin(request);
  const [keySnap, deviceSnap, activeKeysSnap, activeDevicesSnap, settings, totalAppDevicesSnap, active24hSnap, active7dSnap, active30dSnap, androidAppDevicesSnap, windowsAppDevicesSnap] = await Promise.all([
    keysRef.orderBy('createdAt', 'desc').limit(250).get(),
    db.collectionGroup('devices').where('active', '==', true).orderBy('lastSeen', 'desc').limit(100).get(),
    keysRef.where('active', '==', true).get(),
    db.collectionGroup('devices').where('active', '==', true).count().get(),
    readSettings(),
    db.collection('appDevices').count().get(),
    db.collection('appDevices').where('lastSeen', '>=', admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000)).count().get(),
    db.collection('appDevices').where('lastSeen', '>=', admin.firestore.Timestamp.fromMillis(Date.now() - 7 * 24 * 60 * 60 * 1000)).count().get(),
    db.collection('appDevices').where('lastSeen', '>=', admin.firestore.Timestamp.fromMillis(Date.now() - 30 * 24 * 60 * 60 * 1000)).count().get(),
    db.collection('appDevices').where('platform', '==', 'android').count().get(),
    db.collection('appDevices').where('platform', '==', 'windows').count().get()
  ]);
  const keys = await Promise.all(keySnap.docs.map(async d => {
    const count = await d.ref.collection('devices').where('active', '==', true).count().get();
    const key = d.data();
    const expiresAt = key.expiresAt?.toDate?.().toISOString() || null;
    return { id: d.id, ...key, deviceCount: count.data().count, createdAt: key.createdAt?.toDate?.().toISOString() || null,
      expiresAt, expired: !!key.expiresAt && key.expiresAt.toMillis() <= Date.now() };
  }));
  const devices = deviceSnap.docs.map(d => ({ id: d.id, keyId: d.ref.parent.parent?.id || '', ...d.data(), lastSeen: d.data().lastSeen?.toDate?.().toISOString() || null }));
  return { keys, devices, activeKeys: activeKeysSnap.docs.filter(d => d.data().active === true && (!d.data().expiresAt || d.data().expiresAt.toMillis() > Date.now())).length, activeDevices: activeDevicesSnap.data().count,
    appUsage: { totalDevices: totalAppDevicesSnap.data().count, active24h: active24hSnap.data().count,
      active7d: active7dSnap.data().count, active30d: active30dSnap.data().count },
    platformCounts: { android: androidAppDevicesSnap.data().count, windows: windowsAppDevicesSnap.data().count }, settings };
});

exports.adminSetKeyStatus = onCall({ region }, async request => {
  await requireAdmin(request);
  const keyId = text(request.data?.keyId, 64);
  if (!/^[a-f0-9]{64}$/.test(keyId)) fail('invalid-argument', 'Invalid key reference.');
  const ref = keysRef.doc(keyId), active = request.data?.active === true;
  if (!(await ref.get()).exists) fail('not-found', 'Registration key not found.');
  await ref.update({ active });
  const devices = await ref.collection('devices').get();
  const batch = db.batch(); devices.docs.forEach(d => batch.update(d.ref, { active }));
  if (!devices.empty) await batch.commit();
  return { updated: true };
});

exports.adminSetVersionRules = onCall({ region }, async request => {
  await requireAdmin(request);
  const data = request.data || {}, next = {};
  for (const platform of ['android', 'windows']) {
    const minimumVersion = text(data[`${platform}MinimumVersion`], 32);
    if (!parts(minimumVersion)) fail('invalid-argument', `Enter a valid ${platform} minimum version, for example 1.9.3.`);
    const updateUrl = text(data[`${platform}UpdateUrl`], 500);
    if (updateUrl && (!updateUrl.startsWith('https://') || !URL.canParse(updateUrl))) fail('invalid-argument', 'Update links must use HTTPS.');
    next[`${platform}MinimumVersion`] = minimumVersion;
    next[`${platform}UpdateUrl`] = updateUrl;
  }
  await settingsRef.set(next, { merge: true });
  return { saved: true, settings: await readSettings() };
});

exports.appApi = onRequest({ region, cors: true, maxInstances: 10 }, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const method = req.method.toUpperCase(), route = req.path.replace(/\/$/, '') || '/';
    if (['/api/pairing/start', '/api/pairing/status', '/api/device/sync'].includes(route)) {
      if (method !== 'POST') return res.status(405).json({ error: 'POST is required.' });
      return partnerFunctions.handleAppApi(req, res, method, route);
    }
    if (method === 'GET' && route === '/api/config') {
      const platform = text(req.query.platform, 20).toLowerCase(), version = text(req.query.version, 32);
      if (!['android', 'windows'].includes(platform) || !parts(version)) return res.status(400).json({ error: 'Supported platform and valid app version are required.' });
      return res.status(200).json(versionInfo(platform, version, await readSettings()));
    }
    if (method === 'POST' && route === '/api/usage/heartbeat') {
      const deviceId = text(req.body?.deviceId, 128), platform = text(req.body?.platform, 20).toLowerCase();
      const appVersion = text(req.body?.appVersion, 32);
      if (!deviceId || !['android', 'windows'].includes(platform) || !parts(appVersion)) return res.status(400).json({ error: 'Device ID, platform, and valid app version are required.' });
      return res.status(200).json({ ok: true });
    }
    if (method === 'POST' && route === '/api/register') {
      const key = text(req.body?.licenseKey, 80), deviceId = text(req.body?.deviceId, 128);
      const platform = text(req.body?.platform, 20).toLowerCase(), appVersion = text(req.body?.appVersion, 32);
      if (!key || !deviceId || !['android', 'windows'].includes(platform) || !parts(appVersion)) return res.status(400).json({ error: 'Registration key, device ID, platform, and valid app version are required.' });
      const keyRef = keysRef.doc(hash(key)), deviceRef = keyRef.collection('devices').doc(hash(deviceId));
      const [cfg, result] = await Promise.all([readSettings(), db.runTransaction(async tx => {
        const [keyDoc, deviceDoc] = await Promise.all([tx.get(keyRef), tx.get(deviceRef)]);
        if (!keyDoc.exists || keyDoc.data().active !== true) return { status: 403, body: { error: 'Registration key is invalid or disabled.', code: 'license_invalid' } };
        if (keyDoc.data().expiresAt && keyDoc.data().expiresAt.toMillis() <= Date.now()) return { status: 403, body: { error: 'Registration key has expired.', code: 'license_expired', expiresAt: keyDoc.data().expiresAt.toDate().toISOString() } };
        if (!deviceDoc.exists) {
          const active = await tx.get(keyRef.collection('devices').where('active', '==', true));
          if (active.size >= (keyDoc.data().deviceLimit || 1)) return { status: 409, body: { error: 'Registration key device limit reached.' } };
        }
        tx.set(deviceRef, { platform, appVersion, portalHost: safeHost(req.body?.portalHost), registeredAt: deviceDoc.exists ? deviceDoc.data().registeredAt : stamp(), lastSeen: stamp(), deleteAt: deviceDeleteAt(), active: true }, { merge: true });
        return { status: 200, body: { registered: true } };
      })]);
      const keyDoc = result.status === 200 ? await keyRef.get() : null;
      return res.status(result.status).json(result.status === 200 ? { ...result.body, ...licenseInfo(keyDoc.data()), ...versionInfo(platform, appVersion, cfg) } : result.body);
    }
    if (method === 'POST' && route === '/api/heartbeat') {
      const key = text(req.body?.licenseKey, 80), deviceId = text(req.body?.deviceId, 128);
      const platform = text(req.body?.platform, 20).toLowerCase(), appVersion = text(req.body?.appVersion, 32);
      if (!key || !deviceId || !['android', 'windows'].includes(platform) || !parts(appVersion)) return res.status(400).json({ error: 'Registration key, device ID, platform, and valid app version are required.' });
      const keyRef = keysRef.doc(hash(key)), deviceRef = keyRef.collection('devices').doc(hash(deviceId));
      const [keyDoc, deviceDoc, cfg] = await Promise.all([keyRef.get(), deviceRef.get(), readSettings()]);
      if (!keyDoc.exists || keyDoc.data().active !== true || !deviceDoc.exists || deviceDoc.data().active === false) return res.status(403).json({ registered: false, error: 'Device registration is missing or disabled.', code: 'license_invalid' });
      if (keyDoc.data().expiresAt && keyDoc.data().expiresAt.toMillis() <= Date.now()) return res.status(403).json({ registered: false, error: 'Registration key has expired.', code: 'license_expired', ...licenseInfo(keyDoc.data()) });
      await deviceRef.update({ platform, appVersion, portalHost: safeHost(req.body?.portalHost), lastSeen: stamp(), deleteAt: deviceDeleteAt() });
      return res.status(200).json({ registered: true, ...licenseInfo(keyDoc.data()), ...versionInfo(platform, appVersion, cfg) });
    }
    return res.status(404).json({ error: 'Endpoint not found.' });
  } catch (error) {
    logger.error('App API request failed', { message: error?.message || 'unknown' });
    return res.status(500).json({ error: 'Service temporarily unavailable. Please retry.' });
  }
});
