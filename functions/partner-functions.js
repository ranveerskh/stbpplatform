const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { createHash, randomBytes } = require('node:crypto');

const db = admin.firestore();
const auth = admin.auth();
const region = 'northamerica-northeast1';
const accounts = db.collection('partnerAccounts');
const ledger = db.collection('creditLedger');
const portalProfiles = db.collection('portalProfiles');
const pairingCodes = db.collection('pairingCodes');
const assignments = db.collection('deviceAssignments');
const registrationKeys = db.collection('registrationKeys');
const settingsRef = db.collection('platform').doc('settings');
const stamp = () => admin.firestore.FieldValue.serverTimestamp();
const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
const fail = (code, message) => { throw new HttpsError(code, message); };
const cleanText = (value, max = 100) => String(value ?? '').trim().slice(0, max);
const accountRoles = new Set(['distributor', 'reseller', 'provider']);
const parentRole = { distributor: 'admin', reseller: 'distributor', provider: 'reseller' };

function integer(value, fallback = 0) {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : fallback;
}

function addMonthsUtc(fromMillis, months) {
  const source = new Date(fromMillis);
  const day = source.getUTCDate();
  const target = new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + months, 1,
    source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(), source.getUTCMilliseconds()));
  const daysInTargetMonth = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTargetMonth));
  return target.getTime();
}

async function getActor(uid) {
  const adminSnap = await db.collection('admins').doc(uid).get();
  if (adminSnap.exists && adminSnap.data().active !== false && adminSnap.data().role === 'admin') {
    return { uid, role: 'admin', active: true };
  }
  const accountSnap = await accounts.doc(uid).get();
  if (!accountSnap.exists || accountSnap.data().active !== true) fail('permission-denied', 'An active partner account is required.');
  return { uid, ...accountSnap.data() };
}

async function requireActor(request) {
  if (!request.auth?.uid) fail('unauthenticated', 'Sign in to continue.');
  return getActor(request.auth.uid);
}

async function readLimits() {
  const snap = await settingsRef.get();
  return {
    distributorMinCredits: 500,
    distributorToResellerMax: 250,
    resellerToProviderMin: 20,
    ...(snap.exists ? snap.data() : {})
  };
}

function validatePortalUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw || raw.length > 2048) fail('invalid-argument', 'Enter a portal URL up to 2,048 characters.');
  let parsed;
  try { parsed = new URL(raw); } catch { fail('invalid-argument', 'Enter a valid portal URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    fail('invalid-argument', 'Portal URLs must use HTTP or HTTPS and cannot contain embedded username/password fields.');
  }
  if (parsed.hash) parsed.hash = '';
  return parsed.toString();
}

function publicAssignment(data, profile) {
  const expiresAt = data.expiresAt?.toDate?.().getTime?.() || null;
  const graceUntil = data.graceUntil?.toDate?.().getTime?.() || null;
  const now = Date.now();
  const expired = expiresAt !== null && expiresAt <= now;
  const inGrace = expired && graceUntil !== null && graceUntil > now;
  return {
    registered: true,
    licenseLabel: cleanText(data.label, 100) || 'STB Play license',
    licenseExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    graceUntil: graceUntil ? new Date(graceUntil).toISOString() : null,
    licenseExpired: expired && !inGrace,
    inGrace,
    portal: profile ? {
      name: cleanText(profile.name, 100),
      url: profile.portalUrl,
      expiresAt: profile.expiresAt?.toDate?.().toISOString?.() || null,
      revision: profile.revision || 1
    } : null
  };
}

async function inviteAccount({ email, displayName, role, parentUid, credits, actorUid }) {
  const normalizedEmail = cleanText(email, 254).toLowerCase();
  const safeName = cleanText(displayName, 100);
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) fail('invalid-argument', 'Enter a valid email address.');
  if (!accountRoles.has(role)) fail('invalid-argument', 'Choose Distributor, Reseller, or Provider.');
  if (!safeName) fail('invalid-argument', 'Enter an account name.');
  const accountCredits = integer(credits, -1);
  if (accountCredits < 0) fail('invalid-argument', 'Credit allocation must be a whole number of zero or more.');

  let user;
  try {
    user = await auth.createUser({ email: normalizedEmail, displayName: safeName, emailVerified: false, password: randomBytes(24).toString('base64url') });
  } catch (error) {
    if (error?.code === 'auth/email-already-exists') fail('already-exists', 'An account with this email already exists.');
    throw error;
  }
  let passwordResetLink;
  try {
    passwordResetLink = await auth.generatePasswordResetLink(normalizedEmail);
  } catch (error) {
    await auth.deleteUser(user.uid).catch(() => {});
    throw error;
  }

  try {
    const accountRef = accounts.doc(user.uid);
    const ledgerRef = ledger.doc();
    await db.runTransaction(async tx => {
      const parentSnap = parentUid ? await tx.get(accounts.doc(parentUid)) : null;
      if (parentUid && !parentSnap.exists) fail('not-found', 'Parent account was not found.');
      if (parentUid && parentSnap.data().active !== true) fail('failed-precondition', 'Parent account is disabled.');
      const expectedParent = parentRole[role];
      if (expectedParent === 'admin') {
        if (parentUid) fail('invalid-argument', 'A Distributor must be created under Admin.');
      } else if (!parentSnap || parentSnap.data().role !== expectedParent) {
        fail('failed-precondition', `A ${role} account must be created under a ${expectedParent}.`);
      }
      if (role === 'distributor') {
        const limits = await tx.get(settingsRef);
        const minimum = integer(limits.exists ? limits.data().distributorMinCredits : 500, 500);
        if (accountCredits < minimum) fail('failed-precondition', `A Distributor needs at least ${minimum} opening credits.`);
      }
      if (parentUid) {
        const currentCredits = integer(parentSnap.data().credits, 0);
        if (currentCredits < accountCredits) fail('failed-precondition', 'The parent does not have enough credits.');
        if (role === 'provider') {
          const limits = await tx.get(settingsRef);
          const minimum = integer(limits.exists ? limits.data().resellerToProviderMin : 20, 20);
          if (accountCredits < minimum) fail('failed-precondition', `A Provider needs at least ${minimum} opening credits.`);
        }
        if (role === 'reseller') {
          const limits = await tx.get(settingsRef);
          const maximum = integer(limits.exists ? limits.data().distributorToResellerMax : 250, 250);
          if (accountCredits > maximum) fail('failed-precondition', `A Reseller can receive at most ${maximum} credits per allocation.`);
        }
        tx.update(accounts.doc(parentUid), { credits: currentCredits - accountCredits, updatedAt: stamp() });
        tx.set(ledgerRef, { type: 'transfer', fromUid: parentUid, toUid: user.uid, amount: accountCredits, actorUid, createdAt: stamp() });
      } else {
        tx.set(ledgerRef, { type: 'admin_allocation', fromUid: null, toUid: user.uid, amount: accountCredits, actorUid, createdAt: stamp() });
      }
      tx.create(accountRef, { uid: user.uid, email: normalizedEmail, displayName: safeName, role, parentUid: parentUid || null,
        credits: accountCredits, active: true, createdAt: stamp(), createdBy: actorUid, updatedAt: stamp() });
    });
  } catch (error) {
    await auth.deleteUser(user.uid).catch(() => {});
    throw error;
  }

  return { uid: user.uid, email: normalizedEmail, role, credits: accountCredits, passwordResetLink };
}

async function descendantsOf(rootUid) {
  const found = new Map();
  let frontier = [rootUid];
  while (frontier.length && found.size < 1000) {
    const batch = await Promise.all(frontier.map(uid => accounts.where('parentUid', '==', uid).limit(250).get()));
    frontier = [];
    for (const snap of batch) for (const doc of snap.docs) {
      if (!found.has(doc.id)) { found.set(doc.id, doc.data()); frontier.push(doc.id); }
    }
  }
  return found;
}

function auditEvent(actorUid, type, targetUid, detail = {}) {
  return db.collection('platformAudit').add({ actorUid, type, targetUid, detail, createdAt: stamp() });
}

const callables = {
  partnerListDashboard: onCall({ region }, async request => {
    const actor = await requireActor(request);
    const partnerRows = actor.role === 'admin'
      ? (await accounts.limit(500).get()).docs.map(doc => [doc.id, doc.data()])
      : actor.role === 'distributor'
        ? [...await descendantsOf(actor.uid)].slice(0, 1000)
        : (await accounts.where('parentUid', '==', actor.uid).limit(500).get()).docs.map(doc => [doc.id, doc.data()]);
    return {
      account: { uid: actor.uid, role: actor.role, displayName: cleanText(actor.displayName, 100),
        email: cleanText(actor.email, 254), credits: integer(actor.credits, 0) },
      limits: actor.role === 'admin' ? await readLimits() : null,
      accounts: partnerRows.map(([uid, data]) => {
        return { uid, displayName: cleanText(data.displayName, 100), email: cleanText(data.email, 254),
          role: data.role, parentUid: data.parentUid || null, credits: integer(data.credits, 0),
          active: data.active === true, createdAt: data.createdAt?.toDate?.().toISOString?.() || null };
      })
    };
  }),

  partnerProviderDashboard: onCall({ region }, async request => {
    const actor = await requireActor(request);
    if (actor.role !== 'provider') fail('permission-denied', 'Provider access is required.');
    const [profileSnap, assignmentSnap] = await Promise.all([
      portalProfiles.where('ownerUid', '==', actor.uid).limit(250).get(),
      assignments.where('ownerUid', '==', actor.uid).limit(500).get()
    ]);
    const profileById = new Map(profileSnap.docs.map(doc => [doc.id, doc.data()]));
    const licenses = await Promise.all(assignmentSnap.docs.map(async doc => {
      const assignment = doc.data();
      const [keySnap, profile] = await Promise.all([
        registrationKeys.doc(assignment.licenseId).get(),
        Promise.resolve(profileById.get(assignment.portalProfileId))
      ]);
      const key = keySnap.exists ? keySnap.data() : {};
      const expiresAt = key.expiresAt?.toDate?.().getTime?.() || null;
      const graceUntil = key.graceUntil?.toDate?.().getTime?.() || null;
      const now = Date.now();
      const inGrace = !!expiresAt && expiresAt <= now && !!graceUntil && graceUntil > now;
      return {
        deviceRef: doc.id,
        customerLabel: cleanText(assignment.customerLabel, 100) || 'Customer device',
        platform: cleanText(assignment.platform, 20), active: assignment.active === true && key.active === true,
        licenseExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        graceUntil: graceUntil ? new Date(graceUntil).toISOString() : null,
        licenseState: !keySnap.exists || key.active !== true ? 'disabled' : !expiresAt || expiresAt > now ? 'active' : inGrace ? 'grace' : 'expired',
        portalName: cleanText(profile?.name, 100) || 'Unavailable profile',
        portalExpiresAt: profile?.expiresAt?.toDate?.().toISOString?.() || null,
        portalActive: profile?.active === true,
        lastSyncedAt: assignment.lastSyncedAt?.toDate?.().toISOString?.() || null
      };
    }));
    const profiles = profileSnap.docs.map(doc => {
      const profile = doc.data();
      let host = '';
      try { host = new URL(profile.portalUrl).hostname; } catch {}
      return { id: doc.id, name: cleanText(profile.name, 100), host,
        active: profile.active === true, revision: integer(profile.revision, 1),
        expiresAt: profile.expiresAt?.toDate?.().toISOString?.() || null };
    });
    return { account: { displayName: cleanText(actor.displayName, 100), email: cleanText(actor.email, 254), credits: integer(actor.credits, 0) }, profiles, customers: licenses };
  }),

  adminProviderDashboard: onCall({ region }, async request => {
    const actor = await requireActor(request);
    if (actor.role !== 'admin') fail('permission-denied', 'Admin access is required.');
    const assignmentSnap = await assignments.orderBy('updatedAt', 'desc').limit(500).get();
    const rows = assignmentSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const unique = values => [...new Set(values.filter(Boolean))];
    const profileIds = unique(rows.map(row => row.portalProfileId));
    const providerUids = unique(rows.map(row => row.ownerUid));
    const licenseIds = unique(rows.map(row => row.licenseId));
    const fetchRefs = refs => refs.length ? db.getAll(...refs) : Promise.resolve([]);
    const [profileDocs, providerDocs, licenseDocs] = await Promise.all([
      fetchRefs(profileIds.map(id => portalProfiles.doc(id))),
      fetchRefs(providerUids.map(uid => accounts.doc(uid))),
      fetchRefs(licenseIds.map(id => registrationKeys.doc(id)))
    ]);
    const profileMap = new Map(profileDocs.filter(doc => doc.exists).map(doc => [doc.id, doc.data()]));
    const providerMap = new Map(providerDocs.filter(doc => doc.exists).map(doc => [doc.id, doc.data()]));
    const licenseMap = new Map(licenseDocs.filter(doc => doc.exists).map(doc => [doc.id, doc.data()]));
    const now = Date.now();
    const customers = rows.map(row => {
      const profile = profileMap.get(row.portalProfileId) || {};
      const provider = providerMap.get(row.ownerUid) || {};
      const key = licenseMap.get(row.licenseId) || {};
      const expiresAt = key.expiresAt?.toDate?.().getTime?.() || null;
      const graceUntil = key.graceUntil?.toDate?.().getTime?.() || null;
      const inGrace = !!expiresAt && expiresAt <= now && !!graceUntil && graceUntil > now;
      const enabled = row.active === true && key.active === true;
      let portalHost = '';
      try { portalHost = new URL(profile.portalUrl).hostname; } catch {}
      return {
        customerLabel: cleanText(row.customerLabel, 100) || 'Customer device',
        providerName: cleanText(provider.displayName, 100) || 'Provider account',
        providerEmail: cleanText(provider.email, 254),
        licenseId: cleanText(row.licenseId, 128), active: enabled,
        licenseState: !key.active || row.active !== true ? 'disabled' : !expiresAt || expiresAt > now ? 'active' : inGrace ? 'grace' : 'expired',
        licenseExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        portalName: cleanText(profile.name, 100) || 'Unavailable profile', portalHost,
        portalActive: profile.active === true,
        portalExpiresAt: profile.expiresAt?.toDate?.().toISOString?.() || null,
        platform: cleanText(row.platform, 20),
        lastSyncedAt: row.lastSyncedAt?.toDate?.().toISOString?.() || null
      };
    });
    return { customers, limit: 500, hasMore: assignmentSnap.size === 500 };
  }),

  adminCreateDistributor: onCall({ region }, async request => {
    const actor = await requireActor(request);
    if (actor.role !== 'admin') fail('permission-denied', 'Admin access is required.');
    const data = request.data || {};
    const credits = integer(data.credits, -1);
    const limits = await readLimits();
    if (credits < integer(limits.distributorMinCredits, 500)) fail('failed-precondition', `A Distributor needs at least ${limits.distributorMinCredits} opening credits.`);
    const result = await inviteAccount({ email: data.email, displayName: data.displayName, role: 'distributor', parentUid: null, credits, actorUid: actor.uid });
    await auditEvent(actor.uid, 'partner_created', result.uid, { role: result.role, credits: result.credits });
    return result;
  }),

  partnerCreateChild: onCall({ region }, async request => {
    const actor = await requireActor(request);
    const role = cleanText(request.data?.role, 30).toLowerCase();
    const permitted = (actor.role === 'distributor' && role === 'reseller') || (actor.role === 'reseller' && role === 'provider');
    if (!permitted) fail('permission-denied', 'Your account cannot create that partner role.');
    const result = await inviteAccount({ email: request.data?.email, displayName: request.data?.displayName, role,
      parentUid: actor.uid, credits: request.data?.credits, actorUid: actor.uid });
    await auditEvent(actor.uid, 'partner_created', result.uid, { role: result.role, credits: result.credits });
    return result;
  }),

  partnerTransferCredits: onCall({ region }, async request => {
    const actor = await requireActor(request);
    const targetUid = cleanText(request.data?.targetUid, 128);
    const amount = integer(request.data?.amount, -1);
    if (!targetUid || amount <= 0) fail('invalid-argument', 'Choose a recipient and a positive whole-number credit amount.');
    const parentRef = accounts.doc(actor.uid), childRef = accounts.doc(targetUid), ledgerRef = ledger.doc();
    let transfer;
    await db.runTransaction(async tx => {
      const [parentSnap, childSnap, settingsSnap] = await Promise.all([tx.get(parentRef), tx.get(childRef), tx.get(settingsRef)]);
      if (!parentSnap.exists || !childSnap.exists) fail('not-found', 'Partner account was not found.');
      const parent = parentSnap.data(), child = childSnap.data();
      if (parent.active !== true || child.active !== true || child.parentUid !== actor.uid) fail('permission-denied', 'You can transfer credits only to an active account directly under you.');
      const limits = { distributorToResellerMax: 250, resellerToProviderMin: 20, ...(settingsSnap.exists ? settingsSnap.data() : {}) };
      if (parent.role === 'distributor' && child.role === 'reseller' && amount > integer(limits.distributorToResellerMax, 250)) fail('failed-precondition', `Maximum reseller allocation is ${limits.distributorToResellerMax} credits.`);
      else if (parent.role === 'reseller' && child.role === 'provider' && amount < integer(limits.resellerToProviderMin, 20)) fail('failed-precondition', `Minimum provider allocation is ${limits.resellerToProviderMin} credits.`);
      else if (!((parent.role === 'distributor' && child.role === 'reseller') || (parent.role === 'reseller' && child.role === 'provider'))) fail('permission-denied', 'This account relationship cannot transfer credits.');
      const parentCredits = integer(parent.credits, 0), childCredits = integer(child.credits, 0);
      if (parentCredits < amount) fail('failed-precondition', 'Insufficient credits.');
      tx.update(parentRef, { credits: parentCredits - amount, updatedAt: stamp() });
      tx.update(childRef, { credits: childCredits + amount, updatedAt: stamp() });
      tx.create(ledgerRef, { type: 'transfer', fromUid: actor.uid, toUid: targetUid, amount, actorUid: actor.uid, createdAt: stamp() });
      transfer = { fromBalance: parentCredits - amount, toBalance: childCredits + amount };
    });
    await auditEvent(actor.uid, 'credits_transferred', targetUid, { amount });
    return { transferred: amount, ...transfer };
  }),

  adminSetPartnerLimits: onCall({ region }, async request => {
    const actor = await requireActor(request);
    if (actor.role !== 'admin') fail('permission-denied', 'Admin access is required.');
    const data = request.data || {};
    const next = {
      distributorMinCredits: integer(data.distributorMinCredits, -1),
      distributorToResellerMax: integer(data.distributorToResellerMax, -1),
      resellerToProviderMin: integer(data.resellerToProviderMin, -1)
    };
    if (Object.values(next).some(n => n < 1 || n > 1000000)) fail('invalid-argument', 'Credit limits must be whole numbers between 1 and 1,000,000.');
    await settingsRef.set(next, { merge: true });
    await auditEvent(actor.uid, 'partner_limits_updated', 'settings', next);
    return { saved: true, limits: { ...(await readLimits()), ...next } };
  }),

  partnerSetAccountRole: onCall({ region }, async request => {
    const actor = await requireActor(request);
    const targetUid = cleanText(request.data?.targetUid, 128);
    const newRole = cleanText(request.data?.newRole, 30).toLowerCase();
    const newParentUid = cleanText(request.data?.newParentUid, 128) || null;
    if (!targetUid || !accountRoles.has(newRole)) fail('invalid-argument', 'Choose a valid account and role.');
    const targetRef = accounts.doc(targetUid), targetSnap = await targetRef.get();
    if (!targetSnap.exists) fail('not-found', 'Partner account was not found.');
    const target = targetSnap.data();
    if (actor.role !== 'admin') {
      if (actor.role !== 'distributor' || newRole === 'distributor') fail('permission-denied', 'Only Admin or a Distributor in its own branch can change this role.');
      const branch = await descendantsOf(actor.uid);
      if (!branch.has(targetUid)) fail('permission-denied', 'You can edit accounts only in your own branch.');
      if (newParentUid && newParentUid !== actor.uid && !branch.has(newParentUid)) fail('permission-denied', 'The new parent must remain in your branch.');
    }
    const parentUid = newRole === 'distributor' ? null : (newParentUid === null ? target.parentUid : newParentUid);
    let parentRoleValue = 'admin';
    if (parentUid) {
      const parentSnap = await accounts.doc(parentUid).get();
      if (!parentSnap.exists || parentSnap.data().active !== true) fail('failed-precondition', 'Select an active parent account.');
      parentRoleValue = parentSnap.data().role;
    }
    if (parentRole[newRole] !== parentRoleValue) fail('failed-precondition', `A ${newRole} account must be under a ${parentRole[newRole]}.`);
    if (parentUid === targetUid) fail('failed-precondition', 'An account cannot be its own parent.');
    const descendantTree = await descendantsOf(targetUid);
    if (descendantTree.has(parentUid)) fail('failed-precondition', 'An account cannot be moved beneath one of its own descendants.');
    const directChildren = [...descendantTree.entries()].filter(([, data]) => data.parentUid === targetUid);
    const permittedChildRole = { distributor: 'reseller', reseller: 'provider', provider: null }[newRole];
    if (directChildren.some(([, child]) => child.role !== permittedChildRole)) {
      fail('failed-precondition', `Reassign incompatible child partners before changing this account to ${newRole}.`);
    }
    if (actor.role === 'distributor' && target.role === 'distributor') fail('permission-denied', 'A Distributor cannot change another Distributor account.');
    await db.runTransaction(async tx => {
      const [latest, childSnapshot] = await Promise.all([
        tx.get(targetRef), tx.get(accounts.where('parentUid', '==', targetUid))
      ]);
      if (!latest.exists || latest.data().role !== target.role || latest.data().parentUid !== target.parentUid) fail('aborted', 'This account changed while you were editing it. Refresh and retry.');
      if (childSnapshot.docs.some(doc => doc.data().role !== permittedChildRole)) {
        fail('failed-precondition', `Reassign incompatible child partners before changing this account to ${newRole}.`);
      }
      tx.update(targetRef, { role: newRole, parentUid, updatedAt: stamp(), roleUpdatedAt: stamp(), roleUpdatedBy: actor.uid });
    });
    await auditEvent(actor.uid, 'partner_role_changed', targetUid, { oldRole: target.role, newRole, oldParentUid: target.parentUid || null, newParentUid: parentUid });
    return { updated: true, role: newRole, parentUid };
  }),

  partnerCreatePortalProfile: onCall({ region }, async request => {
    const actor = await requireActor(request);
    if (actor.role !== 'provider') fail('permission-denied', 'Only Providers can create portal profiles.');
    const name = cleanText(request.data?.name, 100), portalUrl = validatePortalUrl(request.data?.portalUrl);
    if (!name) fail('invalid-argument', 'Enter a portal profile name.');
    const expiryMillis = request.data?.expiresAt == null || request.data?.expiresAt === '' ? null : Number(request.data.expiresAt);
    if (expiryMillis !== null && (!Number.isFinite(expiryMillis) || expiryMillis <= Date.now())) fail('invalid-argument', 'Portal expiry must be a future date and time.');
    const ref = portalProfiles.doc();
    await ref.set({ ownerUid: actor.uid, name, portalUrl, active: true, revision: 1,
      expiresAt: expiryMillis === null ? null : admin.firestore.Timestamp.fromMillis(expiryMillis), createdAt: stamp(), updatedAt: stamp() });
    await auditEvent(actor.uid, 'portal_profile_created', ref.id, { name });
    return { profileId: ref.id, name, expiresAt: expiryMillis, revision: 1 };
  }),

  partnerUpdatePortalProfile: onCall({ region }, async request => {
    const actor = await requireActor(request);
    const profileId = cleanText(request.data?.profileId, 128), name = cleanText(request.data?.name, 100);
    if (actor.role !== 'provider' || !profileId) fail('permission-denied', 'An active Provider account and profile are required.');
    const ref = portalProfiles.doc(profileId), snap = await ref.get();
    if (!snap.exists || snap.data().ownerUid !== actor.uid) fail('permission-denied', 'You can edit only your own portal profiles.');
    const portalUrl = validatePortalUrl(request.data?.portalUrl);
    const expiryMillis = request.data?.expiresAt == null || request.data?.expiresAt === '' ? null : Number(request.data.expiresAt);
    if (expiryMillis !== null && (!Number.isFinite(expiryMillis) || expiryMillis <= Date.now())) fail('invalid-argument', 'Portal expiry must be a future date and time.');
    const revision = integer(snap.data().revision, 1) + 1;
    await ref.update({ name: name || snap.data().name, portalUrl, revision,
      expiresAt: expiryMillis === null ? null : admin.firestore.Timestamp.fromMillis(expiryMillis), updatedAt: stamp(), updatedBy: actor.uid });
    await auditEvent(actor.uid, 'portal_profile_updated', profileId, { revision });
    return { updated: true, revision, affectedDevicesUpdatedOnNextSync: true };
  }),

  partnerRenewDeviceLicense: onCall({ region }, async request => {
    const actor = await requireActor(request);
    if (actor.role !== 'provider') fail('permission-denied', 'Only Providers can renew customer licenses.');
    const deviceHash = cleanText(request.data?.deviceRef, 128);
    if (!/^[a-f0-9]{64}$/.test(deviceHash)) fail('invalid-argument', 'Choose a valid customer device.');
    const assignmentRef = assignments.doc(deviceHash);
    const assignmentSnap = await assignmentRef.get();
    if (!assignmentSnap.exists || assignmentSnap.data().ownerUid !== actor.uid || assignmentSnap.data().active !== true) {
      fail('permission-denied', 'You can renew only an active device in your account.');
    }
    const assignment = assignmentSnap.data();
    const keyRef = registrationKeys.doc(assignment.licenseId), ledgerRef = ledger.doc();
    let renewal;
    await db.runTransaction(async tx => {
      const [providerSnap, currentAssignment, keySnap] = await Promise.all([tx.get(accounts.doc(actor.uid)), tx.get(assignmentRef), tx.get(keyRef)]);
      if (!providerSnap.exists || providerSnap.data().active !== true || !currentAssignment.exists || currentAssignment.data().ownerUid !== actor.uid || currentAssignment.data().active !== true) {
        fail('failed-precondition', 'Provider or customer device is no longer active. Refresh and retry.');
      }
      if (!keySnap.exists || keySnap.data().active !== true) fail('failed-precondition', 'This customer license is disabled and cannot be renewed.');
      const balance = integer(providerSnap.data().credits, 0);
      if (balance < 1) fail('failed-precondition', 'You need 1 credit to renew this license.');
      const now = Date.now(), oldExpiry = keySnap.data().expiresAt?.toDate?.().getTime?.() || 0;
      const start = Math.max(now, oldExpiry), expiresAtMillis = addMonthsUtc(start, 12);
      const graceUntilMillis = expiresAtMillis + 7 * 24 * 60 * 60 * 1000;
      tx.update(accounts.doc(actor.uid), { credits: balance - 1, updatedAt: stamp() });
      tx.update(keyRef, { expiresAt: admin.firestore.Timestamp.fromMillis(expiresAtMillis),
        graceUntil: admin.firestore.Timestamp.fromMillis(graceUntilMillis), renewedAt: stamp(), renewedBy: actor.uid });
      tx.create(ledgerRef, { type: 'license_renewal', fromUid: actor.uid, toUid: deviceHash, amount: 1, actorUid: actor.uid, createdAt: stamp() });
      renewal = { expiresAt: new Date(expiresAtMillis).toISOString(), graceUntil: new Date(graceUntilMillis).toISOString(), remainingCredits: balance - 1 };
    });
    await auditEvent(actor.uid, 'device_license_renewed', assignment.licenseId, { deviceHash });
    return { renewed: true, ...renewal };
  })
};

async function beginPairing(req, res) {
  const deviceId = cleanText(req.body?.deviceId, 128), platform = cleanText(req.body?.platform, 20).toLowerCase();
  if (!deviceId || !['android', 'windows'].includes(platform)) return res.status(400).json({ error: 'Device ID and supported platform are required.' });
  const deviceHash = sha256(deviceId), code = randomBytes(6).toString('hex').toUpperCase(), token = randomBytes(32).toString('base64url');
  const codeRef = pairingCodes.doc(sha256(code)), deviceRef = db.collection('pairingRequests').doc(deviceHash);
  const now = Date.now(), expiresAt = now + 10 * 60 * 1000;
  let waitSeconds = 0;
  await db.runTransaction(async tx => {
    const [deviceSnap, priorCodeSnap] = await Promise.all([tx.get(deviceRef), tx.get(codeRef)]);
    if (priorCodeSnap.exists) fail('internal', 'Could not create a unique pairing code. Retry.');
    const last = deviceSnap.data()?.lastCreatedAt?.toMillis?.() || 0;
    if (last && now - last < 45 * 1000) { waitSeconds = Math.ceil((45 * 1000 - (now - last)) / 1000); return; }
    tx.set(deviceRef, { lastCreatedAt: admin.firestore.Timestamp.fromMillis(now), activeCodeHash: sha256(code), updatedAt: stamp() }, { merge: true });
    tx.create(codeRef, { deviceHash, platform, deviceTokenHash: sha256(token), createdAt: stamp(), expiresAt: admin.firestore.Timestamp.fromMillis(expiresAt), state: 'pending' });
  });
  if (waitSeconds) return res.status(429).json({ error: `Wait ${waitSeconds} seconds before requesting another pairing code.`, retryAfterSeconds: waitSeconds });
  return res.status(200).json({ pairingCode: code, deviceToken: token, expiresAt: new Date(expiresAt).toISOString() });
}

async function completePairing(request) {
  const actor = await requireActor(request);
  if (actor.role !== 'provider') fail('permission-denied', 'Only a Provider can pair a customer device.');
  const code = cleanText(request.data?.pairingCode, 20).toUpperCase();
  const profileId = cleanText(request.data?.profileId, 128);
  const label = cleanText(request.data?.customerLabel, 100) || 'Customer device';
  if (!/^[A-F0-9]{12}$/.test(code) || !profileId) fail('invalid-argument', 'Enter the pairing code and select a portal profile.');
  const codeRef = pairingCodes.doc(sha256(code)), profileRef = portalProfiles.doc(profileId), providerRef = accounts.doc(actor.uid);
  const licenseKey = `STB-${randomBytes(16).toString('hex').toUpperCase()}`;
  const keyRef = registrationKeys.doc(sha256(licenseKey)), ledgerRef = ledger.doc();
  let result;
  await db.runTransaction(async tx => {
    const [codeSnap, profileSnap, providerSnap] = await Promise.all([tx.get(codeRef), tx.get(profileRef), tx.get(providerRef)]);
    if (!codeSnap.exists || !profileSnap.exists || !providerSnap.exists) fail('not-found', 'Pairing request or portal profile was not found.');
    const pairing = codeSnap.data(), profile = profileSnap.data(), provider = providerSnap.data();
    if (pairing.state !== 'pending' || pairing.expiresAt.toMillis() <= Date.now()) fail('failed-precondition', 'Pairing code expired or was already used. Ask the customer to create a new code.');
    if (profile.ownerUid !== actor.uid || profile.active !== true) fail('permission-denied', 'Select an active portal profile owned by your account.');
    if (provider.active !== true) fail('permission-denied', 'Provider account is disabled.');
    const assignmentRef = assignments.doc(pairing.deviceHash), assignmentSnap = await tx.get(assignmentRef);
    let licenseId, expiresAt, graceUntil;
    if (assignmentSnap.exists && assignmentSnap.data().active === true) {
      const oldAssignment = assignmentSnap.data();
      if (oldAssignment.ownerUid !== actor.uid) fail('already-exists', 'This device is already assigned to another provider. Contact support to transfer it.');
      licenseId = oldAssignment.licenseId;
      const oldKeySnap = await tx.get(registrationKeys.doc(licenseId));
      if (!oldKeySnap.exists || oldKeySnap.data().active !== true) fail('failed-precondition', 'Existing device license is disabled. Contact support.');
      expiresAt = oldKeySnap.data().expiresAt;
      graceUntil = oldKeySnap.data().graceUntil;
      tx.update(assignmentRef, { portalProfileId: profileId, deviceTokenHash: pairing.deviceTokenHash,
        platform: pairing.platform, customerLabel: label, providerName: cleanText(provider.displayName, 100), updatedAt: stamp() });
      result = { existingLicense: true };
    } else {
      const balance = integer(provider.credits, 0);
      if (balance < 1) fail('failed-precondition', 'You need at least 1 credit to activate a customer device.');
      const activatedAtMillis = Date.now(), expiresAtMillis = addMonthsUtc(activatedAtMillis, 12), graceUntilMillis = expiresAtMillis + 7 * 24 * 60 * 60 * 1000;
      expiresAt = admin.firestore.Timestamp.fromMillis(expiresAtMillis);
      graceUntil = admin.firestore.Timestamp.fromMillis(graceUntilMillis);
      licenseId = keyRef.id;
      tx.update(providerRef, { credits: balance - 1, updatedAt: stamp() });
      tx.create(ledgerRef, { type: 'license_issued', fromUid: actor.uid, toUid: pairing.deviceHash, amount: 1, actorUid: actor.uid, createdAt: stamp() });
      tx.create(keyRef, { label, active: true, deviceLimit: 1, ownerUid: actor.uid, durationMonths: 12,
        activatedAt: admin.firestore.Timestamp.fromMillis(activatedAtMillis), expiresAt, graceUntil,
        createdAt: stamp(), createdBy: actor.uid, portalProfileId: profileId });
      tx.create(assignmentRef, { deviceHash: pairing.deviceHash, licenseId, ownerUid: actor.uid, portalProfileId: profileId,
        deviceTokenHash: pairing.deviceTokenHash, platform: pairing.platform, customerLabel: label,
        providerName: cleanText(provider.displayName, 100), active: true, createdAt: stamp(), updatedAt: stamp(), lastSyncedAt: stamp() });
      tx.create(keyRef.collection('devices').doc(pairing.deviceHash), { active: true, platform: pairing.platform,
        registeredAt: stamp(), lastSeen: stamp(), deleteAt: admin.firestore.Timestamp.fromMillis(graceUntilMillis) });
      result = { existingLicense: false, remainingCredits: balance - 1 };
    }
    tx.update(codeRef, { state: 'completed', providerUid: actor.uid, profileId, assignmentId: pairing.deviceHash,
      licenseId, completedAt: stamp() });
    result = { ...result, licenseId, expiresAt: expiresAt?.toDate?.().toISOString?.() || null,
      graceUntil: graceUntil?.toDate?.().toISOString?.() || null };
  });
  await auditEvent(actor.uid, 'device_paired', result.licenseId, { profileId, existingLicense: result.existingLicense });
  return result;
}

async function getPairingStatus(req, res) {
  const deviceId = cleanText(req.body?.deviceId, 128), code = cleanText(req.body?.pairingCode, 20).toUpperCase();
  const token = cleanText(req.body?.deviceToken, 200);
  if (!deviceId || !token || !/^[A-F0-9]{12}$/.test(code)) return res.status(400).json({ error: 'Device ID, device token, and valid pairing code are required.' });
  const codeSnap = await pairingCodes.doc(sha256(code)).get();
  if (!codeSnap.exists || codeSnap.data().deviceHash !== sha256(deviceId)) return res.status(404).json({ error: 'Pairing request was not found.' });
  const pairing = codeSnap.data();
  if (pairing.deviceTokenHash !== sha256(token)) return res.status(403).json({ error: 'Pairing request is not authorized for this device.' });
  if (pairing.expiresAt.toMillis() <= Date.now() && pairing.state === 'pending') return res.status(410).json({ state: 'expired', error: 'Pairing code expired. Create a new code.' });
  if (pairing.state !== 'completed') return res.status(200).json({ state: 'pending', expiresAt: pairing.expiresAt.toDate().toISOString() });
  const assignmentSnap = await assignments.doc(pairing.assignmentId).get();
  if (!assignmentSnap.exists || assignmentSnap.data().active !== true) return res.status(403).json({ error: 'Device assignment is disabled.' });
  const data = assignmentSnap.data();
  if (data.deviceHash !== sha256(deviceId)) return res.status(403).json({ error: 'Device does not match pairing request.' });
  const [keySnap, profileSnap] = await Promise.all([registrationKeys.doc(data.licenseId).get(), portalProfiles.doc(data.portalProfileId).get()]);
  if (!keySnap.exists || !profileSnap.exists || profileSnap.data().active !== true) return res.status(403).json({ error: 'License or portal assignment is unavailable.' });
  return res.status(200).json({ state: 'completed', ...publicAssignment(keySnap.data(), profileSnap.data()) });
}

async function syncDevice(req, res) {
  const deviceId = cleanText(req.body?.deviceId, 128), token = cleanText(req.body?.deviceToken, 200);
  const version = cleanText(req.body?.appVersion, 32), platform = cleanText(req.body?.platform, 20).toLowerCase();
  if (!deviceId || !token || !['android', 'windows'].includes(platform) || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    return res.status(400).json({ error: 'Device ID, device token, supported platform, and valid app version are required.' });
  }
  const deviceHash = sha256(deviceId), assignmentRef = assignments.doc(deviceHash), snap = await assignmentRef.get();
  if (!snap.exists || snap.data().active !== true || snap.data().deviceTokenHash !== sha256(token)) return res.status(403).json({ registered: false, error: 'Device assignment is not active.', code: 'device_unlinked' });
  const data = snap.data();
  const [keySnap, profileSnap, cfgSnap] = await Promise.all([registrationKeys.doc(data.licenseId).get(), portalProfiles.doc(data.portalProfileId).get(), settingsRef.get()]);
  if (!keySnap.exists || keySnap.data().active !== true || !profileSnap.exists || profileSnap.data().active !== true) return res.status(403).json({ registered: false, error: 'License or portal assignment is unavailable.', code: 'license_invalid' });
  await assignmentRef.update({ lastSyncedAt: stamp() });
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  const minimumVersion = cfg[`${platform}MinimumVersion`] || '1.0.0';
  const versionParts = value => { const m = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)/); return m ? m.slice(1).map(Number) : null; };
  const a = versionParts(version), b = versionParts(minimumVersion);
  let updateRequired = !a || !b;
  if (a && b) {
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) { updateRequired = a[i] < b[i]; break; }
    }
  }
  return res.status(200).json({ ...publicAssignment(keySnap.data(), profileSnap.data()), updateRequired,
    minimumVersion, updateUrl: cfg[`${platform}UpdateUrl`] || '', providerName: cleanText(data.providerName, 100) });
}

async function handleAppApi(req, res, method, route) {
  if (method === 'POST' && route === '/api/pairing/start') return beginPairing(req, res);
  if (method === 'POST' && route === '/api/pairing/status') return getPairingStatus(req, res);
  if (method === 'POST' && route === '/api/device/sync') return syncDevice(req, res);
  return null;
}

callables.partnerCompletePairing = onCall({ region }, completePairing);

module.exports = { callables, handleAppApi, addMonthsUtc };
