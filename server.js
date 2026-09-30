import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8787);
const adminKey = process.env.STB_ADMIN_KEY || '';
const dbPath = process.env.STB_DB_PATH || join(root, 'data', 'stbplay.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS licenses (
    id TEXT PRIMARY KEY, key_hash TEXT UNIQUE NOT NULL, key_hint TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
    device_limit INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY, license_id TEXT NOT NULL REFERENCES licenses(id),
    platform TEXT NOT NULL, app_version TEXT NOT NULL, portal_host TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL, last_seen TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
  );
`);
for (const [k, v] of [['min_android_version', '1.0.0'], ['min_windows_version', '1.0.0'], ['android_update_url', ''], ['windows_update_url', '']]) {
  db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(k, v);
}
const q = (s, ...a) => db.prepare(s).all(...a);
const one = (s, ...a) => db.prepare(s).get(...a);
const run = (s, ...a) => db.prepare(s).run(...a);
const hash = (v) => createHash('sha256').update(v).digest('hex');
const now = () => new Date().toISOString();
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
const parseBody = async (req) => {
  let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 16_384) throw new Error('Request too large'); }
  return body ? JSON.parse(body) : {};
};
const compareVersion = (a, b) => {
  const aa = String(a).split(/[.+-]/).slice(0, 3).map(n => Number.parseInt(n, 10) || 0);
  const bb = String(b).split(/[.+-]/).slice(0, 3).map(n => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
  return 0;
};
const isAdmin = (req) => {
  const given = req.headers['x-admin-key'] || '';
  return adminKey.length > 0 && given.length === adminKey.length && timingSafeEqual(Buffer.from(given), Buffer.from(adminKey));
};
const settings = () => Object.fromEntries(q('SELECT key,value FROM settings').map(r => [r.key, r.value]));
const validPlatform = (p) => ['android', 'windows'].includes(String(p || '').toLowerCase());
const updateStatus = (platform, version, cfg) => {
  const p = String(platform).toLowerCase();
  if (!validPlatform(p)) return { ok: false, error: 'Unsupported platform' };
  const min = cfg[`min_${p}_version`];
  return { ok: true, minimumVersion: min, updateRequired: compareVersion(version, min) < 0, updateUrl: cfg[`${p}_update_url`] || '' };
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/v1/config') {
      const p = (url.searchParams.get('platform') || '').toLowerCase();
      if (!validPlatform(p)) return json(res, 400, { error: 'platform must be android or windows' });
      const cfg = settings();
      return json(res, 200, { platform: p, minimumVersion: cfg[`min_${p}_version`], updateUrl: cfg[`${p}_update_url`] || '' });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/register') {
      const b = await parseBody(req); const licenseKey = String(b.licenseKey || '').trim();
      const deviceId = String(b.deviceId || '').trim(); const platform = String(b.platform || '').toLowerCase();
      const appVersion = String(b.appVersion || '').trim();
      if (!licenseKey || !deviceId || deviceId.length > 128 || !validPlatform(platform) || !appVersion) return json(res, 400, { error: 'licenseKey, deviceId, platform, and appVersion are required' });
      const lic = one('SELECT * FROM licenses WHERE key_hash=? AND active=1', hash(licenseKey));
      if (!lic) return json(res, 403, { error: 'Registration key is invalid or disabled' });
      const existing = one('SELECT * FROM devices WHERE id=?', deviceId);
      if (existing && existing.license_id !== lic.id) return json(res, 409, { error: 'Device is already registered to another key' });
      if (!existing && one('SELECT COUNT(*) AS n FROM devices WHERE license_id=? AND active=1', lic.id).n >= lic.device_limit) return json(res, 409, { error: 'Registration key device limit reached' });
      const host = String(b.portalHost || '').toLowerCase().replace(/[^a-z0-9.:-]/g, '').slice(0, 253);
      if (existing) run('UPDATE devices SET platform=?,app_version=?,portal_host=?,last_seen=?,active=1 WHERE id=?', platform, appVersion, host, now(), deviceId);
      else run('INSERT INTO devices(id,license_id,platform,app_version,portal_host,registered_at,last_seen) VALUES(?,?,?,?,?,?,?)', deviceId, lic.id, platform, appVersion, host, now(), now());
      return json(res, 200, { registered: true, ...updateStatus(platform, appVersion, settings()) });
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/heartbeat') {
      const b = await parseBody(req); const id = String(b.deviceId || '').trim();
      const p = String(b.platform || '').toLowerCase(); const version = String(b.appVersion || '').trim();
      if (!id || !validPlatform(p) || !version) return json(res, 400, { error: 'deviceId, platform, and appVersion are required' });
      const host = String(b.portalHost || '').toLowerCase().replace(/[^a-z0-9.:-]/g, '').slice(0, 253);
      const updated = run('UPDATE devices SET platform=?,app_version=?,portal_host=?,last_seen=? WHERE id=? AND active=1', p, version, host, now(), id);
      if (!updated.changes) return json(res, 403, { registered: false, error: 'Device registration is missing or disabled' });
      return json(res, 200, { registered: true, ...updateStatus(p, version, settings()) });
    }
    if (url.pathname.startsWith('/admin/api/')) {
      if (!isAdmin(req)) return json(res, 401, { error: 'Admin authentication required' });
      if (req.method === 'GET' && url.pathname === '/admin/api/summary') {
        const total = one('SELECT COUNT(*) n FROM devices WHERE active=1').n;
        const registered = one('SELECT COUNT(*) n FROM licenses WHERE active=1').n;
        return json(res, 200, { activeDevices: total, activeKeys: registered, platforms: q('SELECT platform,COUNT(*) count FROM devices WHERE active=1 GROUP BY platform'), recent: q('SELECT id,platform,app_version appVersion,portal_host portalHost,last_seen lastSeen FROM devices WHERE active=1 ORDER BY last_seen DESC LIMIT 20'), settings: settings() });
      }
      if (req.method === 'GET' && url.pathname === '/admin/api/keys') return json(res, 200, q('SELECT id,key_hint keyHint,label,active,device_limit deviceLimit,created_at createdAt,(SELECT COUNT(*) FROM devices d WHERE d.license_id=licenses.id AND d.active=1) deviceCount FROM licenses ORDER BY created_at DESC'));
      if (req.method === 'POST' && url.pathname === '/admin/api/keys') {
        const b = await parseBody(req); const label = String(b.label || '').trim().slice(0, 100); const limit = Math.max(1, Math.min(100, Number(b.deviceLimit || 1)));
        const key = `STB-${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`; const id = randomUUID();
        run('INSERT INTO licenses(id,key_hash,key_hint,label,device_limit,created_at) VALUES(?,?,?,?,?,?)', id, hash(key), key.slice(-4), label, limit, now());
        return json(res, 201, { id, key, label, deviceLimit: limit });
      }
      const keyMatch = url.pathname.match(/^\/admin\/api\/keys\/([^/]+)$/);
      if (req.method === 'PATCH' && keyMatch) {
        const b = await parseBody(req); const active = b.active ? 1 : 0;
        const result = run('UPDATE licenses SET active=? WHERE id=?', active, keyMatch[1]);
        if (!result.changes) return json(res, 404, { error: 'Key not found' });
        if (!active) run('UPDATE devices SET active=0 WHERE license_id=?', keyMatch[1]);
        return json(res, 200, { updated: true });
      }
      if (req.method === 'PUT' && url.pathname === '/admin/api/settings') {
        const b = await parseBody(req);
        for (const p of ['android', 'windows']) {
          if (typeof b[`min_${p}_version`] === 'string' && b[`min_${p}_version`].length <= 32) run('UPDATE settings SET value=? WHERE key=?', b[`min_${p}_version`], `min_${p}_version`);
          if (typeof b[`${p}_update_url`] === 'string' && b[`${p}_update_url`].length <= 500) run('UPDATE settings SET value=? WHERE key=?', b[`${p}_update_url`], `${p}_update_url`);
        }
        return json(res, 200, { settings: settings() });
      }
      return json(res, 404, { error: 'Not found' });
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(await readFile(join(root, 'public', 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return res.end(await readFile(join(root, 'public', 'app.js')));
    }
    if (req.method === 'GET' && url.pathname === '/style.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' }); return res.end(await readFile(join(root, 'public', 'style.css')));
    }
    json(res, 404, { error: 'Not found' });
  } catch (err) { json(res, 400, { error: err instanceof SyntaxError ? 'Invalid JSON' : 'Request could not be processed' }); }
}).listen(port, '0.0.0.0', () => {
  if (!adminKey) console.warn('Set STB_ADMIN_KEY before exposing the dashboard.');
  console.log(`STB Play platform listening on :${port}`);
});
