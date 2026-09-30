const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const { createHash, randomBytes } = require('node:crypto');

admin.initializeApp();
const db = admin.firestore();
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
async function readSettings() {
  const snap = await settingsRef.get();
  return { androidMinimumVersion: '1.0.0', windowsMinimumVersion: '1.0.0', androidUpdateUrl: '', windowsUpdateUrl: '', ...(snap.exists ? snap.data() : {}) };
}
async function requireAdmin(request) {
  if (!request.auth?.uid) fail('unauthenticated', 'Sign in to continue.');
  const snap = await db.collection('admins').doc(request.auth.uid).get();
  if (!snap.exists || snap.data().active === false) fail('permission-denied', 'Admin access is required.');
}

exports.adminCreateKey = onCall({ region }, async request => {
  await requireAdmin(request);
  const label = text(request.data?.label, 100);
  const deviceLimit = Math.max(1, Math.min(100, Number(request.data?.deviceLimit) || 1));
  const key = `STB-${randomBytes(16).toString('hex').toUpperCase()}`;
  await keysRef.doc(hash(key)).set({ label, keyHint: key.slice(-4), active: true, deviceLimit, createdAt: stamp() });
  return { key, keyHint: key.slice(-4), deviceLimit };
});

exports.adminListDashboard = onCall({ region }, async request => {
  await requireAdmin(request);
  const [keySnap, deviceSnap, activeKeysSnap, activeDevicesSnap, androidDevicesSnap, windowsDevicesSnap, settings] = await Promise.all([
    keysRef.orderBy('createdAt', 'desc').limit(250).get(),
    db.collectionGroup('devices').where('active', '==', true).orderBy('lastSeen', 'desc').limit(100).get(),
    keysRef.where('active', '==', true).count().get(),
    db.collectionGroup('devices').where('active', '==', true).count().get(),
    db.collectionGroup('devices').where('active', '==', true).where('platform', '==', 'android').count().get(),
    db.collectionGroup('devices').where('active', '==', true).where('platform', '==', 'windows').count().get(),
    readSettings()
  ]);
  const keys = await Promise.all(keySnap.docs.map(async d => {
    const count = await d.ref.collection('devices').where('active', '==', true).count().get();
    return { id: d.id, ...d.data(), deviceCount: count.data().count, createdAt: d.data().createdAt?.toDate?.().toISOString() || null };
  }));
  const devices = deviceSnap.docs.map(d => ({ id: d.id, keyId: d.ref.parent.parent?.id || '', ...d.data(), lastSeen: d.data().lastSeen?.toDate?.().toISOString() || null }));
  return { keys, devices, activeKeys: activeKeysSnap.data().count, activeDevices: activeDevicesSnap.data().count, platformCounts: { android: androidDevicesSnap.data().count, windows: windowsDevicesSnap.data().count }, settings };
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
    if (method === 'GET' && route === '/api/config') {
      const platform = text(req.query.platform, 20).toLowerCase(), version = text(req.query.version, 32);
      if (!['android', 'windows'].includes(platform) || !parts(version)) return res.status(400).json({ error: 'Supported platform and valid app version are required.' });
      return res.status(200).json(versionInfo(platform, version, await readSettings()));
    }
    if (method === 'POST' && route === '/api/register') {
      const key = text(req.body?.licenseKey, 80), deviceId = text(req.body?.deviceId, 128);
      const platform = text(req.body?.platform, 20).toLowerCase(), appVersion = text(req.body?.appVersion, 32);
      if (!key || !deviceId || !['android', 'windows'].includes(platform) || !parts(appVersion)) return res.status(400).json({ error: 'Registration key, device ID, platform, and valid app version are required.' });
      const keyRef = keysRef.doc(hash(key)), deviceRef = keyRef.collection('devices').doc(hash(deviceId));
      const [cfg, result] = await Promise.all([readSettings(), db.runTransaction(async tx => {
        const [keyDoc, deviceDoc] = await Promise.all([tx.get(keyRef), tx.get(deviceRef)]);
        if (!keyDoc.exists || keyDoc.data().active !== true) return { status: 403, body: { error: 'Registration key is invalid or disabled.' } };
        if (!deviceDoc.exists) {
          const active = await tx.get(keyRef.collection('devices').where('active', '==', true));
          if (active.size >= (keyDoc.data().deviceLimit || 1)) return { status: 409, body: { error: 'Registration key device limit reached.' } };
        }
        tx.set(deviceRef, { platform, appVersion, portalHost: safeHost(req.body?.portalHost), registeredAt: deviceDoc.exists ? deviceDoc.data().registeredAt : stamp(), lastSeen: stamp(), active: true }, { merge: true });
        return { status: 200, body: { registered: true } };
      })]);
      return res.status(result.status).json(result.status === 200 ? { ...result.body, ...versionInfo(platform, appVersion, cfg) } : result.body);
    }
    if (method === 'POST' && route === '/api/heartbeat') {
      const key = text(req.body?.licenseKey, 80), deviceId = text(req.body?.deviceId, 128);
      const platform = text(req.body?.platform, 20).toLowerCase(), appVersion = text(req.body?.appVersion, 32);
      if (!key || !deviceId || !['android', 'windows'].includes(platform) || !parts(appVersion)) return res.status(400).json({ error: 'Registration key, device ID, platform, and valid app version are required.' });
      const keyRef = keysRef.doc(hash(key)), deviceRef = keyRef.collection('devices').doc(hash(deviceId));
      const [keyDoc, deviceDoc, cfg] = await Promise.all([keyRef.get(), deviceRef.get(), readSettings()]);
      if (!keyDoc.exists || keyDoc.data().active !== true || !deviceDoc.exists || deviceDoc.data().active === false) return res.status(403).json({ registered: false, error: 'Device registration is missing or disabled.' });
      await deviceRef.update({ platform, appVersion, portalHost: safeHost(req.body?.portalHost), lastSeen: stamp() });
      return res.status(200).json({ registered: true, ...versionInfo(platform, appVersion, cfg) });
    }
    return res.status(404).json({ error: 'Endpoint not found.' });
  } catch (error) {
    logger.error('App API request failed', { message: error?.message || 'unknown' });
    return res.status(500).json({ error: 'Service temporarily unavailable. Please retry.' });
  }
});
