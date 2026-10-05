const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { FieldValue, Timestamp, AggregateField } = require('firebase-admin/firestore');
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
const stamp = () => FieldValue.serverTimestamp();
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

function portalProfileIsActive(profile, now = Date.now()) {
  if (profile?.active !== true) return false;
  const expiresAt = profile.expiresAt?.toDate?.().getTime?.();
  return expiresAt == null || expiresAt > now;
}

async function getActor(uid) {
  const adminSnap = await db.collection('admins').doc(uid).get();
  if (adminSnap.exists && adminSnap.data().active !== false && (!adminSnap.data().role || adminSnap.data().role === 'admin')) {
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
  const trialUntil = data.trialUntil?.toDate?.().getTime?.() || null;
  const now = Date.now();
  const expired = expiresAt !== null && expiresAt <= now;
  const inGrace = expired && graceUntil !== null && graceUntil > now;
  const inTrial = data.trial === true && trialUntil !== null && trialUntil > now;
  return {
    registered: true,
    licenseLabel: cleanText(data.label, 100) || 'STB Play license',
    licenseExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    graceUntil: graceUntil ? new Date(graceUntil).toISOString() : null,
    licenseExpired: expired && !inGrace,
    inGrace,
    trial: data.trial === true,
    trialExpiresAt: trialUntil ? new Date(trialUntil).toISOString() : null,
    trialExpired: data.trial === true && !inTrial,
    portal: profile ? {
      name: cleanText(profile.name, 100),
      url: profile.portalUrl,
      expiresAt: profile.expiresAt?.toDate?.().toISOString?.() || null,
      revision: profile.revision || 1
    } : null
  };
}

async function inviteAccount({ email, displayName, role, parentUid, credits, actorUid, actorRole, actorName, actorEmail }) {
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
        const currentCredits = integer(parentSnap.data().credits, -1);
        if (currentCredits < 0) fail('failed-precondition', 'The parent credit balance is invalid. Contact Admin.');
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
        credits: accountCredits, active: true, createdAt: stamp(), createdBy: actorUid,
        createdByRole: cleanText(actorRole, 30) || 'admin', createdByName: cleanText(actorName, 100),
        createdByEmail: cleanText(actorEmail, 254).toLowerCase(), updatedAt: stamp() });
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
    const accountNames = new Map(partnerRows.map(([uid, data]) => [uid, cleanText(data.displayName, 100)]));
    accountNames.set(actor.uid, actor.role === 'admin' ? 'Admin' : cleanText(actor.displayName, 100) || 'You');
    const recentLedgerSnap = await ledger.orderBy('createdAt', 'desc').limit(100).get();
    const missingAccountUids = [...new Set(recentLedgerSnap.docs.flatMap(doc => {
      const row = doc.data();
      return [row.fromUid, row.toUid, row.actorUid].filter(uid => uid && !accountNames.has(uid));
    }))];
    const deletedAccounts = missingAccountUids.length ? await db.getAll(...missingAccountUids.map(uid => db.collection('deletedPartnerAccounts').doc(uid))) : [];
    deletedAccounts.filter(doc => doc.exists).forEach(doc => accountNames.set(doc.id, `${cleanText(doc.data().displayName, 100)} (deleted)`));
    const visibleUids = new Set([actor.uid, ...partnerRows.map(([uid]) => uid)]);
    const recentActivity = recentLedgerSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(item => actor.role === 'admin' || visibleUids.has(item.fromUid) || visibleUids.has(item.toUid))
      .slice(0, 60).map(item => ({ type: cleanText(item.type, 40), amount: integer(item.amount, 0), durationYears: integer(item.durationYears, 0),
        reason: cleanText(item.reason, 40),
        fromUid: item.fromUid || null, toUid: item.toUid || null, actorUid: item.actorUid || null, fromName: item.fromUid ? cleanText(item.fromName, 100) || accountNames.get(item.fromUid) || 'Partner account' : 'Admin',
        toName: item.toUid ? cleanText(item.toName, 100) || accountNames.get(item.toUid) || 'Customer device' : '—',
        actorName: accountNames.get(item.actorUid) || (item.actorUid ? 'Admin' : '—'),
        createdAt: item.createdAt?.toDate?.().toISOString?.() || null }));
    const deviceEvents = recentActivity.filter(item => item.toUid && /^[a-f0-9]{64}$/.test(item.toUid));
    const deviceDocs = deviceEvents.length ? await db.getAll(...deviceEvents.map(item => assignments.doc(item.toUid))) : [];
    const deviceNames = new Map(deviceDocs.filter(doc => doc.exists).map(doc => [doc.id, cleanText(doc.data().customerLabel, 100) || 'Customer device']));
    recentActivity.forEach(item => {
      if (item.toUid && deviceNames.has(item.toUid)) item.toName = deviceNames.get(item.toUid);
    });
    const dashboardLimits = await readLimits();
    const pendingDeletions = actor.role === 'admin'
      ? (await db.collection('platformDeletions').where('authCleanupPending', '==', true).limit(100).get()).docs.map(doc => doc.data().summary)
      : [];
    return {
      pendingDeletions,
      account: { uid: actor.uid, role: actor.role, displayName: cleanText(actor.displayName, 100),
        email: cleanText(actor.email, 254), credits: integer(actor.credits, 0) },
      limits: actor.role === 'admin' ? dashboardLimits : null,
      transferRules: {
        distributorToResellerMax: integer(dashboardLimits.distributorToResellerMax, 250),
        resellerToProviderMin: integer(dashboardLimits.resellerToProviderMin, 20)
      },
      recentActivity,
      accounts: partnerRows.map(([uid, data]) => {
        return { uid, displayName: cleanText(data.displayName, 100), email: cleanText(data.email, 254),
          role: data.role, parentUid: data.parentUid || null,
          parentName: data.parentUid ? accountNames.get(data.parentUid) || 'Parent account' : 'Admin', credits: integer(data.credits, 0),
          active: data.active === true, archived: data.archived === true, archivedAt: data.archivedAt?.toDate?.().toISOString?.() || null, createdAt: data.createdAt?.toDate?.().toISOString?.() || null, createdByUid: data.createdBy || null,
          createdByRole: cleanText(data.createdByRole, 30),
          createdByName: data.createdBy ? (cleanText(data.createdByName, 100) || accountNames.get(data.createdBy) || (data.createdBy === actor.uid ? cleanText(actor.displayName, 100) : 'Admin')) : '—',
          createdByEmail: cleanText(data.createdByEmail, 254),
          roleUpdatedAt: data.roleUpdatedAt?.toDate?.().toISOString?.() || null };
      })
    };
  }),

  adminCreditSummary: onCall({ region }, async request => {
    const actor = await requireActor(request);
    if (actor.role !== 'admin') fail('permission-denied', 'Admin access is required.');
    const sum = async query => (await query.aggregate({ total: AggregateField.sum('amount') }).get()).data().total || 0;
    const [allocated, issued, renewed, transferred, held, signedAdjustment] = await Promise.all([
      sum(ledger.where('type', '==', 'admin_allocation')),
      sum(ledger.where('type', '==', 'license_issued')),
      sum(ledger.where('type', '==', 'license_renewal')),
      sum(ledger.where('type', '==', 'transfer')),
      (await accounts.aggregate({ total: AggregateField.sum('credits') }).get()).data().total || 0,
      (await ledger.where('type', '==', 'admin_adjustment').aggregate({ total: AggregateField.sum('delta') }).get()).data().total || 0
    ]);
    const used = issued + renewed;
    // Adjustments can add or remove credits, so reconcile using their signed delta.
    return { allocated, totalAllocated: allocated + signedAdjustment, adjustmentNet: signedAdjustment, used, transferred, held,
      reconciliation: allocated + signedAdjustment - used - held };
  }),

  partnerArchiveAccount: onCall({ region }, async request => {
    const actor = await requireActor(request);
    const targetUid = cleanText(request.data?.targetUid, 128);
    const archived = request.data?.archived === true;
    if (!targetUid || targetUid === actor.uid) fail('invalid-argument', 'Choose another account to archive or restore.');
    const ref = accounts.doc(targetUid);
    let targetRole;
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) fail('not-found', 'Partner account was not found.');
      const target = snap.data(); targetRole = cleanText(target.role, 30);
      if (!accountRoles.has(targetRole)) fail('failed-precondition', 'This record is not an active partner account.');
      const permittedParentRole = { reseller: 'distributor', provider: 'reseller' }[targetRole];
      const isDirectParent = target.parentUid === actor.uid && actor.role === permittedParentRole;
      if (actor.role !== 'admin' && !isDirectParent) fail('permission-denied', 'You can archive only an account directly under you.');
      if (target.archived === archived) return;
      if (archived) {
        const [children, customerRows] = await Promise.all([
          tx.get(accounts.where('parentUid', '==', targetUid)),
          tx.get(assignments.where('ownerUid', '==', targetUid))
        ]);
        if (!children.empty) fail('failed-precondition', 'This account has child accounts. Move or archive those accounts first.');
        if (customerRows.docs.some(row => row.data().archived !== true)) fail('failed-precondition', 'This account still has customers. Archive those customers first.');
        if (integer(target.credits, -1) !== 0) fail('failed-precondition', 'The account must have 0 credits before it can be archived. Transfer or record an Admin credit adjustment first; balances are never discarded.');
        tx.update(ref, { active: false, archived: true, archivedAt: stamp(), archivedBy: actor.uid, updatedAt: stamp() });
      } else {
        let currentParentRole = 'admin';
        if (target.parentUid) {
          const parent = await tx.get(accounts.doc(target.parentUid));
          if (!parent.exists || parent.data().active !== true || parent.data().archived === true) fail('failed-precondition', 'Restore the parent account first.');
          currentParentRole = cleanText(parent.data().role, 30);
        }
        if (parentRole[targetRole] !== currentParentRole) fail('failed-precondition', `A ${targetRole} account must remain under a ${parentRole[targetRole]}.`);
        tx.update(ref, { active: true, archived: false, archivedAt: FieldValue.delete(), archivedBy: FieldValue.delete(), updatedAt: stamp() });
      }
    });
    await auth.updateUser(targetUid, { disabled: archived });
    await auditEvent(actor.uid, archived ? 'partner_account_archived' : 'partner_account_restored', targetUid, { role: targetRole });
    return { updated: true, archived };
  }),

  partnerArchiveCustomer: onCall({ region }, async request => {
    const actor = await requireActor(request);
    if (actor.role !== 'admin' && !accountRoles.has(actor.role)) fail('permission-denied', 'An active partner account is required.');
    const deviceRefId = cleanText(request.data?.deviceRef, 128);
    const archived = request.data?.archived === true;
    if (!deviceRefId) fail('invalid-argument', 'Choose a customer device.');
    const assignmentRef = assignments.doc(deviceRefId);
    let details;
    await db.runTransaction(async tx => {
      const assignmentSnap = await tx.get(assignmentRef);
      if (!assignmentSnap.exists) fail('not-found', 'Customer assignment was not found.');
      const assignment = assignmentSnap.data();
      if (actor.role !== 'admin' && assignment.ownerUid !== actor.uid) fail('permission-denied', 'You can manage customers assigned to your own account only.');
      if (assignment.archived === archived) { details = assignment; return; }
      const keyRef = registrationKeys.doc(cleanText(assignment.licenseId, 128));
      const keySnap = await tx.get(keyRef);
      const deviceDocs = keySnap.exists ? await tx.get(keyRef.collection('devices')) : null;
      const key = keySnap.exists ? keySnap.data() : {};
      if (archived) {
        tx.update(assignmentRef, { archived: true, archivedAt: stamp(), archivedBy: actor.uid,
          archivedAssignmentActive: assignment.active === true, active: false, updatedAt: stamp() });
        if (keySnap.exists) tx.update(keyRef, { archived: true, archivedAt: stamp(), archivedBy: actor.uid,
          archivedLicenseActive: key.active === true, active: false });
        deviceDocs?.docs.forEach(device => tx.update(device.ref, { active: false }));
      } else {
        tx.update(assignmentRef, { archived: false, archivedAt: FieldValue.delete(), archivedBy: FieldValue.delete(),
          active: assignment.archivedAssignmentActive === true, archivedAssignmentActive: FieldValue.delete(), updatedAt: stamp() });
        if (keySnap.exists) tx.update(keyRef, { archived: false, archivedAt: FieldValue.delete(), archivedBy: FieldValue.delete(),
          active: key.archivedLicenseActive === true, archivedLicenseActive: FieldValue.delete() });
        deviceDocs?.docs.forEach(device => tx.update(device.ref, { active: key.archivedLicenseActive === true }));
      }
      details = assignment;
    });
    if (!details) fail('not-found', 'Customer assignment was not found.');
    await auditEvent(actor.uid, archived ? 'customer_archived' : 'customer_restored', deviceRefId,
      { customerLabel: cleanText(details.customerLabel, 100), licenseId: cleanText(details.licenseId, 128) });
    return { updated: true, archived };
  }),

  partnerProviderDashboard: onCall({ region }, async request => {
    const actor = await requireActor(request);
    if (!accountRoles.has(actor.role)) fail('permission-denied', 'An active partner account is required.');
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
      const inTrial = key.trial === true && !!key.trialUntil?.toDate?.().getTime?.() && key.trialUntil.toDate().getTime() > now;
      return {
        deviceRef: doc.id,
        deviceId: doc.id, archived: assignment.archived === true,
        licenseId: cleanText(assignment.licenseId, 128),
        keyHint: cleanText(key.keyHint, 4),
        createdByName: cleanText(key.createdByName, 100) || cleanText(actor.displayName, 100) || 'You',
        durationYears: key.trial === true ? 0 : Math.max(1, Math.round(integer(key.durationMonths, 12) / 12)),
        portalMac: cleanText(assignment.portalMac, 17).toUpperCase(),
        customerLabel: cleanText(assignment.customerLabel, 100) || 'Customer device',
        platform: cleanText(assignment.platform, 20), active: assignment.active === true && key.active === true,
        licenseExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        graceUntil: graceUntil ? new Date(graceUntil).toISOString() : null,
        trial: key.trial === true, trialExpiresAt: key.trialUntil?.toDate?.().toISOString?.() || null,
        licenseState: !keySnap.exists || key.active !== true ? 'disabled' : inTrial ? 'trial' : !expiresAt || expiresAt > now ? 'active' : inGrace ? 'grace' : 'expired',
        portalName: cleanText(profile?.name, 100) || 'Unavailable profile', portalProfileId: cleanText(assignment.portalProfileId, 128),
        portalExpiresAt: profile?.expiresAt?.toDate?.().toISOString?.() || null,
        portalActive: portalProfileIsActive(profile),
        lastSyncedAt: assignment.lastSyncedAt?.toDate?.().toISOString?.() || null
      };
    }));
    const profiles = profileSnap.docs.map(doc => {
      const profile = doc.data();
      let host = '';
      try { host = new URL(profile.portalUrl).hostname; } catch {}
      return { id: doc.id, name: cleanText(profile.name, 100), host,
        active: portalProfileIsActive(profile), expired: !!profile.expiresAt?.toDate?.().getTime?.() && profile.expiresAt.toDate().getTime() <= Date.now(), revision: integer(profile.revision, 1),
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
    const [profileDocs, providerDocs, licenseDocs, availableProfiles] = await Promise.all([
      fetchRefs(profileIds.map(id => portalProfiles.doc(id))),
      fetchRefs(providerUids.map(uid => accounts.doc(uid))),
      fetchRefs(licenseIds.map(id => registrationKeys.doc(id))),
      portalProfiles.where('active', '==', true).get()
    ]);
    const parentUids = unique(providerDocs.filter(doc => doc.exists).map(doc => doc.data().parentUid));
    const parentDocs = await fetchRefs(parentUids.map(uid => accounts.doc(uid)));
    const profileMap = new Map(profileDocs.filter(doc => doc.exists).map(doc => [doc.id, doc.data()]));
    const providerMap = new Map([...providerDocs, ...parentDocs].filter(doc => doc.exists).map(doc => [doc.id, doc.data()]));
    const licenseMap = new Map(licenseDocs.filter(doc => doc.exists).map(doc => [doc.id, doc.data()]));
    const now = Date.now();
    const customers = rows.map(row => {
      const profile = profileMap.get(row.portalProfileId) || {};
      const provider = providerMap.get(row.ownerUid) || {};
      const parent = provider.parentUid ? (providerMap.get(provider.parentUid) || {}) : {};
      const key = licenseMap.get(row.licenseId) || {};
      const expiresAt = key.expiresAt?.toDate?.().getTime?.() || null;
      const graceUntil = key.graceUntil?.toDate?.().getTime?.() || null;
      const inGrace = !!expiresAt && expiresAt <= now && !!graceUntil && graceUntil > now;
      const inTrial = key.trial === true && !!key.trialUntil?.toDate?.().getTime?.() && key.trialUntil.toDate().getTime() > now;
      const enabled = row.active === true && key.active === true;
      let portalHost = '';
      try { portalHost = new URL(profile.portalUrl).hostname; } catch {}
      return {
        customerLabel: cleanText(row.customerLabel, 100) || 'Customer device',
        deviceRef: row.id, archived: row.archived === true, ownerUid: cleanText(row.ownerUid, 128),
        deviceId: row.id,
        portalMac: cleanText(row.portalMac, 17).toUpperCase(),
        providerName: cleanText(provider.displayName, 100) || 'Partner account',
        providerEmail: cleanText(provider.email, 254), partnerRole: cleanText(provider.role, 30),
        parentName: cleanText(parent.displayName, 100) || (provider.parentUid ? 'Parent account' : 'Admin'),
        parentUid: cleanText(provider.parentUid, 128) || null,
        createdBy: cleanText(key.createdBy, 128) || cleanText(row.ownerUid, 128),
        createdByName: cleanText(key.createdByName, 100) || cleanText(provider.displayName, 100) || 'Partner account',
        createdByEmail: cleanText(key.createdByEmail, 254) || cleanText(provider.email, 254),
        licenseId: cleanText(row.licenseId, 128), active: enabled,
        trial: key.trial === true, trialExpiresAt: key.trialUntil?.toDate?.().toISOString?.() || null,
        licenseState: !key.active || row.active !== true ? 'disabled' : inTrial ? 'trial' : !expiresAt || expiresAt > now ? 'active' : inGrace ? 'grace' : 'expired',
        licenseExpiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        portalName: cleanText(profile.name, 100) || 'Unavailable profile', portalHost,
        portalProfileId: cleanText(row.portalProfileId, 128),
        portalActive: portalProfileIsActive(profile),
        portalExpiresAt: profile.expiresAt?.toDate?.().toISOString?.() || null,
        platform: cleanText(row.platform, 20),
        lastSyncedAt: row.lastSyncedAt?.toDate?.().toISOString?.() || null
      };
    });
    const profiles = availableProfiles.docs.filter(doc => portalProfileIsActive(doc.data()) &&
      providerMap.get(doc.data().ownerUid)?.active === true).map(doc => {
      const profile = doc.data();
      let host = '';
      try { host = new URL(profile.portalUrl).hostname; } catch {}
      return { id: doc.id, ownerUid: profile.ownerUid, name: cleanText(profile.name, 100), host, active: true };
    });
    return { customers, profiles, limit: 500, hasMore: assignmentSnap.size === 500 };
  }),

  adminListPairingProfiles: onCall({ region }, async request => {
    const actor = await requireActor(request);
    if (actor.role !== 'admin') fail('permission-denied', 'Admin access is required.');
    const partnerUid = cleanText(request.data?.partnerUid, 128);
    if (!partnerUid) fail('invalid-argument', 'Choose the partner account that will own this customer.');
    const [partnerSnap, profileSnap] = await Promise.all([
      accounts.doc(partnerUid).get(),
      portalProfiles.where('ownerUid', '==', partnerUid).limit(250).get()
    ]);
    if (!partnerSnap.exists || partnerSnap.data().active !== true || !accountRoles.has(partnerSnap.data().role)) {
      fail('not-found', 'Choose an active Distributor, Reseller, or Provider account.');
    }
    const partner = partnerSnap.data();
    const profiles = profileSnap.docs.map(doc => {
      const profile = doc.data();
      let host = '';
      try { host = new URL(profile.portalUrl).hostname; } catch {}
      return { id: doc.id, name: cleanText(profile.name, 100), host, active: portalProfileIsActive(profile),
        expiresAt: profile.expiresAt?.toDate?.().toISOString?.() || null };
    }).filter(profile => profile.active);
    return { partner: { uid: partnerUid, displayName: cleanText(partner.displayName, 100),
      role: partner.role, credits: integer(partner.credits, 0) }, profiles };
  }),

  adminCreateDistributor: onCall({ region }, async request => {
    const actor = await requireActor(request);
    if (actor.role !== 'admin') fail('permission-denied', 'Admin access is required.');
    const data = request.data || {};
    const credits = integer(data.credits, -1);
    const limits = await readLimits();
    if (credits < integer(limits.distributorMinCredits, 500)) fail('failed-precondition', `A Distributor needs at least ${limits.distributorMinCredits} opening credits.`);
    const result = await inviteAccount({ email: data.email, displayName: data.displayName, role: 'distributor', parentUid: null, credits,
      actorUid: actor.uid, actorRole: 'admin', actorName: cleanText(request.auth.token?.name || request.auth.token?.email, 100), actorEmail: request.auth.token?.email });
    await auditEvent(actor.uid, 'partner_created', result.uid, { role: result.role, credits: result.credits });
    return result;
  }),

  adminAdjustPartnerCredits: onCall({ region }, async request => {
    const actor = await requireActor(request);
    if (actor.role !== 'admin') fail('permission-denied', 'Admin access is required.');
    const targetUid = cleanText(request.data?.targetUid, 128);
    const delta = integer(request.data?.delta, 0);
    if (!targetUid || !delta || Math.abs(delta) > 100000000) fail('invalid-argument', 'Enter a non-zero whole-number credit adjustment.');
    const accountRef = accounts.doc(targetUid), ledgerRef = ledger.doc();
    let balance;
    await db.runTransaction(async tx => {
      const snap = await tx.get(accountRef);
      if (!snap.exists || snap.data().active !== true) fail('not-found', 'Active partner account was not found.');
      const current = integer(snap.data().credits, -1), next = current + delta;
      if (current < 0 || !Number.isSafeInteger(next) || next < 0) fail('failed-precondition', 'Adjustment would make the credit balance negative or invalid.');
      tx.update(accountRef, { credits: next, updatedAt: stamp() });
      tx.create(ledgerRef, { type: 'admin_adjustment', fromUid: delta < 0 ? targetUid : null,
        toUid: delta > 0 ? targetUid : null, amount: Math.abs(delta), delta, actorUid: actor.uid, createdAt: stamp() });
      balance = next;
    });
    await auditEvent(actor.uid, 'partner_credits_adjusted', targetUid, { delta, balance });
    return { updated: true, balance };
  }),

  partnerCreateChild: onCall({ region }, async request => {
    const actor = await requireActor(request);
    const role = cleanText(request.data?.role, 30).toLowerCase();
    const permitted = (actor.role === 'distributor' && role === 'reseller') || (actor.role === 'reseller' && role === 'provider');
    if (!permitted) fail('permission-denied', 'Your account cannot create that partner role.');
    const result = await inviteAccount({ email: request.data?.email, displayName: request.data?.displayName, role,
      parentUid: actor.uid, credits: request.data?.credits, actorUid: actor.uid, actorRole: actor.role,
      actorName: actor.displayName, actorEmail: actor.email });
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
      const parentCredits = integer(parent.credits, -1), childCredits = integer(child.credits, -1);
      if (parentCredits < 0 || childCredits < 0) fail('failed-precondition', 'A credit balance is invalid. Contact Admin.');
      if (parentCredits < amount) fail('failed-precondition', 'Insufficient credits.');
      const nextChildCredits = childCredits + amount;
      if (!Number.isSafeInteger(nextChildCredits) || nextChildCredits < 0) fail('failed-precondition', 'This transfer would exceed the recipient credit limit.');
      tx.update(parentRef, { credits: parentCredits - amount, updatedAt: stamp() });
      tx.update(childRef, { credits: nextChildCredits, updatedAt: stamp() });
      tx.create(ledgerRef, { type: 'transfer', fromUid: actor.uid, toUid: targetUid, amount, actorUid: actor.uid, createdAt: stamp() });
      transfer = { fromBalance: parentCredits - amount, toBalance: nextChildCredits };
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
    if (actor.role !== 'admin' && (actor.role !== 'distributor' || newRole === 'distributor')) {
      fail('permission-denied', 'Only Admin or a Distributor in its own branch can change this role.');
    }
    const parentUid = newRole === 'distributor' ? null : (newParentUid === null ? target.parentUid : newParentUid);
    const permittedChildRole = { distributor: 'reseller', reseller: 'provider', provider: null }[newRole];
    if (actor.role === 'distributor' && target.role === 'distributor') fail('permission-denied', 'A Distributor cannot change another Distributor account.');
    const accountPathIncludes = async (tx, startUid, ancestorUid) => {
      let currentUid = startUid;
      const visited = new Set();
      for (let depth = 0; currentUid && depth < 5; depth++) {
        if (currentUid === ancestorUid) return true;
        if (visited.has(currentUid)) return false;
        visited.add(currentUid);
        const snap = await tx.get(accounts.doc(currentUid));
        if (!snap.exists) return false;
        currentUid = cleanText(snap.data().parentUid, 128);
      }
      return false;
    };
    await db.runTransaction(async tx => {
      const [latest, childSnapshot] = await Promise.all([
        tx.get(targetRef), tx.get(accounts.where('parentUid', '==', targetUid))
      ]);
      if (!latest.exists || latest.data().role !== target.role || latest.data().parentUid !== target.parentUid) fail('aborted', 'This account changed while you were editing it. Refresh and retry.');
      let parentRoleValue = 'admin';
      if (parentUid) {
        const parentSnap = await tx.get(accounts.doc(parentUid));
        if (!parentSnap.exists || parentSnap.data().active !== true) fail('failed-precondition', 'Select an active parent account.');
        parentRoleValue = parentSnap.data().role;
      }
      if (parentRole[newRole] !== parentRoleValue) fail('failed-precondition', `A ${newRole} account must be under a ${parentRole[newRole]}.`);
      if (parentUid === targetUid) fail('failed-precondition', 'An account cannot be its own parent.');
      if (parentUid && await accountPathIncludes(tx, parentUid, targetUid)) fail('failed-precondition', 'An account cannot be moved beneath one of its own descendants.');
      if (actor.role === 'distributor') {
        const actorSnap = await tx.get(accounts.doc(actor.uid));
        if (!actorSnap.exists || actorSnap.data().role !== 'distributor' || actorSnap.data().active !== true) fail('permission-denied', 'An active Distributor account is required. Refresh and retry.');
        if (!await accountPathIncludes(tx, targetUid, actor.uid)) fail('permission-denied', 'You can edit accounts only in your own branch.');
        if (parentUid && !await accountPathIncludes(tx, parentUid, actor.uid)) fail('permission-denied', 'The new parent must remain in your branch.');
      }
      const incompatibleChildren = childSnapshot.docs.filter(doc => permittedChildRole
        ? doc.data().role !== permittedChildRole
        : true);
      if (incompatibleChildren.length) {
        const labels = incompatibleChildren.slice(0, 3).map(doc => cleanText(doc.data().displayName || doc.data().email, 100)).filter(Boolean);
        const childNames = labels.length ? ` Affected child accounts: ${labels.join(', ')}.` : '';
        const allowed = permittedChildRole
          ? `must all be ${permittedChildRole}s`
          : 'must be moved because Provider accounts cannot have child accounts';
        fail('failed-precondition', `This account has child accounts that ${allowed}.${childNames} Reassign the incompatible child accounts before changing this role.`);
      }
      tx.update(targetRef, { role: newRole, parentUid, updatedAt: stamp(), roleUpdatedAt: stamp(), roleUpdatedBy: actor.uid });
    });
    await auditEvent(actor.uid, 'partner_role_changed', targetUid, { oldRole: target.role, newRole, oldParentUid: target.parentUid || null, newParentUid: parentUid });
    return { updated: true, role: newRole, parentUid };
  }),

  partnerCreatePortalProfile: onCall({ region }, async request => {
    const actor = await requireActor(request);
    if (!accountRoles.has(actor.role)) fail('permission-denied', 'An active partner account is required.');
    const name = cleanText(request.data?.name, 100), portalUrl = validatePortalUrl(request.data?.portalUrl);
    if (!name) fail('invalid-argument', 'Enter a portal profile name.');
    const expiryMillis = request.data?.expiresAt == null || request.data?.expiresAt === '' ? null : Number(request.data.expiresAt);
    if (expiryMillis !== null && (!Number.isFinite(expiryMillis) || expiryMillis <= Date.now())) fail('invalid-argument', 'Portal expiry must be a future date and time.');
    const ref = portalProfiles.doc();
    await db.runTransaction(async tx => {
      const owner = await tx.get(accounts.doc(actor.uid));
      if (!owner.exists || owner.data().active !== true) fail('permission-denied', 'An active partner account is required.');
      tx.create(ref, { ownerUid: actor.uid, name, portalUrl, active: true, revision: 1,
        expiresAt: expiryMillis === null ? null : Timestamp.fromMillis(expiryMillis), createdAt: stamp(), updatedAt: stamp() });
    });
    await auditEvent(actor.uid, 'portal_profile_created', ref.id, { name });
    return { profileId: ref.id, name, expiresAt: expiryMillis, revision: 1 };
  }),

  partnerUpdatePortalProfile: onCall({ region }, async request => {
    const actor = await requireActor(request);
    const profileId = cleanText(request.data?.profileId, 128), name = cleanText(request.data?.name, 100);
    if (!accountRoles.has(actor.role) || !profileId) fail('permission-denied', 'An active partner account and profile are required.');
    const ref = portalProfiles.doc(profileId), snap = await ref.get();
    if (!snap.exists || snap.data().ownerUid !== actor.uid) fail('permission-denied', 'You can edit only your own portal profiles.');
    const portalUrl = validatePortalUrl(request.data?.portalUrl);
    const expiryMillis = request.data?.expiresAt == null || request.data?.expiresAt === '' ? null : Number(request.data.expiresAt);
    if (expiryMillis !== null && (!Number.isFinite(expiryMillis) || expiryMillis <= Date.now())) fail('invalid-argument', 'Portal expiry must be a future date and time.');
    const revision = integer(snap.data().revision, 1) + 1;
    await ref.update({ name: name || snap.data().name, portalUrl, revision,
      expiresAt: expiryMillis === null ? null : Timestamp.fromMillis(expiryMillis), updatedAt: stamp(), updatedBy: actor.uid });
    await auditEvent(actor.uid, 'portal_profile_updated', profileId, { revision });
    return { updated: true, revision, affectedDevicesUpdatedOnNextSync: true };
  }),

  partnerSwitchDevicePortal: onCall({ region }, async request => {
    const actor = await requireActor(request);
    if (actor.role !== 'admin' && !accountRoles.has(actor.role)) fail('permission-denied', 'An active partner account is required.');
    const deviceHash = cleanText(request.data?.deviceRef, 128);
    const profileId = cleanText(request.data?.profileId, 128);
    if (!/^[a-f0-9]{64}$/.test(deviceHash) || !profileId) fail('invalid-argument', 'Choose a customer device and portal.');
    const assignmentRef = assignments.doc(deviceHash), profileRef = portalProfiles.doc(profileId);
    await db.runTransaction(async tx => {
      const [assignmentSnap, profileSnap] = await Promise.all([tx.get(assignmentRef), tx.get(profileRef)]);
      if (!assignmentSnap.exists || (actor.role !== 'admin' && assignmentSnap.data().ownerUid !== actor.uid)) {
        fail('permission-denied', 'You can switch portals only for customer devices assigned by your account.');
      }
      const assignment = assignmentSnap.data();
      if (assignment.archived === true) fail('failed-precondition', 'Restore this customer before switching portals.');
      const owner = await tx.get(accounts.doc(assignment.ownerUid));
      if (!owner.exists || owner.data().active !== true) fail('failed-precondition', 'Restore or enable the customer\'s partner account first.');
      if (!profileSnap.exists || !portalProfileIsActive(profileSnap.data()) || profileSnap.data().ownerUid !== assignment.ownerUid) {
        fail('permission-denied', 'Choose an active portal profile owned by the customer\'s partner account.');
      }
      tx.update(assignmentRef, { portalProfileId: profileId, updatedAt: stamp(), portalChangedAt: stamp(), portalChangedBy: actor.uid });
    });
    await auditEvent(actor.uid, 'device_portal_switched', deviceHash, { profileId });
    return { updated: true, takesEffectOnNextDeviceSync: true };
  }),

  partnerRenewDeviceLicense: onCall({ region }, async request => {
    const actor = await requireActor(request);
    if (!accountRoles.has(actor.role)) fail('permission-denied', 'An active partner account is required to renew customer licenses.');
    const deviceHash = cleanText(request.data?.deviceRef, 128);
    if (!/^[a-f0-9]{64}$/.test(deviceHash)) fail('invalid-argument', 'Choose a valid customer device.');
    const assignmentRef = assignments.doc(deviceHash);
    const assignmentSnap = await assignmentRef.get();
    if (!assignmentSnap.exists || assignmentSnap.data().ownerUid !== actor.uid || assignmentSnap.data().active !== true) {
      fail('permission-denied', 'You can renew only an active device in your account.');
    }
    const assignment = assignmentSnap.data();
    const keyRef = registrationKeys.doc(assignment.licenseId), ledgerRef = ledger.doc();
    const registrationRef = keyRef.collection('devices').doc(deviceHash);
    let renewal;
    await db.runTransaction(async tx => {
      const [providerSnap, currentAssignment, keySnap, registrationSnap] = await Promise.all([
        tx.get(accounts.doc(actor.uid)), tx.get(assignmentRef), tx.get(keyRef), tx.get(registrationRef)
      ]);
      if (!providerSnap.exists || providerSnap.data().active !== true || !currentAssignment.exists || currentAssignment.data().ownerUid !== actor.uid || currentAssignment.data().active !== true) {
        fail('failed-precondition', 'Provider or customer device is no longer active. Refresh and retry.');
      }
      if (!keySnap.exists || keySnap.data().active !== true) fail('failed-precondition', 'This customer license is disabled and cannot be renewed.');
      const years = integer(request.data?.years, -1);
      if (years < 1 || years > 10) fail('invalid-argument', 'Choose a license term from 1 to 10 years.');
      const balance = integer(providerSnap.data().credits, 0);
      if (balance < years) fail('failed-precondition', `You need ${years} credits to renew this license for ${years} year${years === 1 ? '' : 's'}.`);
      const now = Date.now(), oldExpiry = keySnap.data().expiresAt?.toDate?.().getTime?.() || 0;
      const start = Math.max(now, oldExpiry), expiresAtMillis = addMonthsUtc(start, years * 12);
      const graceUntilMillis = expiresAtMillis + 7 * 24 * 60 * 60 * 1000;
      tx.update(accounts.doc(actor.uid), { credits: balance - years, updatedAt: stamp() });
      const convertingTrial = keySnap.data().trial === true;
      const licenseExpiry = convertingTrial ? addMonthsUtc(now, years * 12) : expiresAtMillis;
      const licenseGrace = licenseExpiry + 7 * 24 * 60 * 60 * 1000;
      tx.update(keyRef, { trial: false, trialUntil: FieldValue.delete(), expiresAt: Timestamp.fromMillis(licenseExpiry),
        graceUntil: Timestamp.fromMillis(licenseGrace), renewedAt: stamp(), renewedBy: actor.uid,
        durationMonths: integer(keySnap.data().durationMonths, 12) + years * 12 });
      if (registrationSnap.exists) tx.update(registrationRef, { active: true, deleteAt: Timestamp.fromMillis(licenseGrace + 365 * 24 * 60 * 60 * 1000) });
      tx.create(ledgerRef, { type: convertingTrial ? 'license_issued' : 'license_renewal', fromUid: actor.uid, toUid: deviceHash, amount: years, durationYears: years, actorUid: actor.uid, createdAt: stamp() });
      renewal = { expiresAt: new Date(licenseExpiry).toISOString(), graceUntil: new Date(licenseGrace).toISOString(), remainingCredits: balance - years, durationYears: years, activatedFromTrial: convertingTrial };
    });
    await auditEvent(actor.uid, 'device_license_renewed', assignment.licenseId, { deviceHash });
    return { renewed: true, ...renewal };
  })
};

async function beginPairing(req, res) {
  const deviceId = cleanText(req.body?.deviceId, 128), platform = cleanText(req.body?.platform, 20).toLowerCase();
  const portalMac = cleanText(req.body?.portalMac, 17).toUpperCase();
  if (!deviceId || !['android', 'windows'].includes(platform)) return res.status(400).json({ error: 'Device ID and supported platform are required.' });
  if (portalMac && !/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(portalMac)) return res.status(400).json({ error: 'Portal MAC address is invalid.' });
  const deviceHash = sha256(deviceId), code = randomBytes(6).toString('hex').toUpperCase(), token = randomBytes(32).toString('base64url');
  const codeRef = pairingCodes.doc(sha256(code)), deviceRef = db.collection('pairingRequests').doc(deviceHash);
  const now = Date.now(), expiresAt = now + 10 * 60 * 1000;
  let waitSeconds = 0;
  await db.runTransaction(async tx => {
    const [deviceSnap, priorCodeSnap] = await Promise.all([tx.get(deviceRef), tx.get(codeRef)]);
    if (priorCodeSnap.exists) fail('internal', 'Could not create a unique pairing code. Retry.');
    const last = deviceSnap.data()?.lastCreatedAt?.toMillis?.() || 0;
    if (last && now - last < 45 * 1000) { waitSeconds = Math.ceil((45 * 1000 - (now - last)) / 1000); return; }
    tx.set(deviceRef, { lastCreatedAt: Timestamp.fromMillis(now), activeCodeHash: sha256(code), updatedAt: stamp() }, { merge: true });
    tx.create(codeRef, { deviceHash, platform, portalMac: portalMac || null, deviceTokenHash: sha256(token), createdAt: stamp(), expiresAt: Timestamp.fromMillis(expiresAt), state: 'pending' });
  });
  if (waitSeconds) return res.status(429).json({ error: `Wait ${waitSeconds} seconds before requesting another pairing code.`, retryAfterSeconds: waitSeconds });
  return res.status(200).json({ pairingCode: code, deviceToken: token, expiresAt: new Date(expiresAt).toISOString() });
}

async function completePairing(request) {
  const actor = await requireActor(request);
  if (actor.role !== 'admin' && !accountRoles.has(actor.role)) fail('permission-denied', 'An active partner account is required to pair customer devices.');
  const partnerUid = actor.role === 'admin' ? cleanText(request.data?.partnerUid, 128) : actor.uid;
  if (actor.role === 'admin' && !partnerUid) fail('invalid-argument', 'Choose the partner account that will own this customer.');
  if (actor.role !== 'admin' && request.data?.partnerUid) fail('permission-denied', 'Partners can pair customers only into their own account.');
  const code = cleanText(request.data?.pairingCode, 20).toUpperCase();
  const profileId = cleanText(request.data?.profileId, 128);
  const label = cleanText(request.data?.customerLabel, 100) || 'Customer device';
  const trial = request.data?.trial === true;
  const durationYears = integer(request.data?.durationYears, -1);
  if (!trial && (durationYears < 1 || durationYears > 10)) fail('invalid-argument', 'Choose a license term from 1 to 10 years.');
  if (!/^[A-F0-9]{12}$/.test(code) || !profileId) fail('invalid-argument', 'Enter the pairing code and select a portal profile.');
  const codeRef = pairingCodes.doc(sha256(code)), profileRef = portalProfiles.doc(profileId), ownerRef = accounts.doc(partnerUid);
  const licenseKey = `STB-${randomBytes(16).toString('hex').toUpperCase()}`;
  const keyRef = registrationKeys.doc(sha256(licenseKey)), ledgerRef = ledger.doc();
  const creatorName = actor.role === 'admin'
    ? cleanText(request.auth.token?.name || request.auth.token?.email || 'Admin', 100)
    : cleanText(actor.displayName, 100) || cleanText(actor.email, 254);
  const creatorEmail = cleanText(actor.email || request.auth.token?.email, 254).toLowerCase();
  let result;
  await db.runTransaction(async tx => {
    const [codeSnap, profileSnap, ownerSnap] = await Promise.all([tx.get(codeRef), tx.get(profileRef), tx.get(ownerRef)]);
    if (!codeSnap.exists || !profileSnap.exists || !ownerSnap.exists) fail('not-found', 'Pairing request, partner account, or portal profile was not found.');
    const pairing = codeSnap.data(), profile = profileSnap.data(), owner = ownerSnap.data();
    if (pairing.state !== 'pending' || pairing.expiresAt.toMillis() <= Date.now()) fail('failed-precondition', 'Pairing code expired or was already used. Ask the customer to create a new code.');
    if (!accountRoles.has(owner.role) || owner.active !== true) fail('failed-precondition', 'The selected partner account is not active.');
    if (profile.ownerUid !== partnerUid || !portalProfileIsActive(profile)) fail('permission-denied', 'Select an active, unexpired portal profile owned by the selected partner account.');
    const assignmentRef = assignments.doc(pairing.deviceHash), assignmentSnap = await tx.get(assignmentRef);
    const deletedDevice = await tx.get(db.collection('deletedCustomerDevices').doc(pairing.deviceHash));
    const portalMac = pairing.portalMac || (assignmentSnap.exists ? cleanText(assignmentSnap.data().portalMac, 17).toUpperCase() : '');
    let licenseId, expiresAt, graceUntil;
    if (assignmentSnap.exists && assignmentSnap.data().active === true) {
      const oldAssignment = assignmentSnap.data();
      if (oldAssignment.ownerUid !== partnerUid) fail('already-exists', 'This device is already assigned to another partner. Contact Admin to transfer it.');
      licenseId = oldAssignment.licenseId;
      const oldKeySnap = await tx.get(registrationKeys.doc(licenseId));
      if (!oldKeySnap.exists || oldKeySnap.data().active !== true) fail('failed-precondition', 'Existing device license is disabled. Contact support.');
      expiresAt = oldKeySnap.data().expiresAt;
      graceUntil = oldKeySnap.data().graceUntil;
      tx.update(assignmentRef, { portalProfileId: profileId, deviceTokenHash: pairing.deviceTokenHash,
        platform: pairing.platform, portalMac: portalMac || null, customerLabel: label, providerName: cleanText(owner.displayName, 100), updatedAt: stamp() });
      result = { existingLicense: true, creditsUsed: 0, remainingCredits: integer(owner.credits, 0) };
    } else {
      if (trial && (assignmentSnap.exists || deletedDevice.exists)) fail('failed-precondition', 'This device has already been paired. A 7-day trial is available only once per device; choose a paid license instead.');
      const balance = integer(owner.credits, 0);
      if (!trial && balance < durationYears) {
        const subject = actor.role === 'admin' ? `${cleanText(owner.displayName, 100) || 'The selected partner'} needs` : 'You need';
        fail('failed-precondition', `${subject} ${durationYears} credits to activate this device for ${durationYears} year${durationYears === 1 ? '' : 's'}.`);
      }
      const activatedAtMillis = Date.now(), trialUntilMillis = trial ? activatedAtMillis + 7 * 24 * 60 * 60 * 1000 : null;
      const expiresAtMillis = trial ? trialUntilMillis : addMonthsUtc(activatedAtMillis, durationYears * 12);
      const graceUntilMillis = trial ? null : expiresAtMillis + 7 * 24 * 60 * 60 * 1000;
      expiresAt = Timestamp.fromMillis(expiresAtMillis);
      graceUntil = graceUntilMillis ? Timestamp.fromMillis(graceUntilMillis) : null;
      licenseId = keyRef.id;
      if (!trial) {
        tx.update(ownerRef, { credits: balance - durationYears, updatedAt: stamp() });
        tx.create(ledgerRef, { type: 'license_issued', fromUid: partnerUid, toUid: pairing.deviceHash, amount: durationYears, durationYears, actorUid: actor.uid, createdAt: stamp() });
      }
      tx.create(keyRef, { label, keyHint: licenseKey.slice(-4), active: true, deviceLimit: 1, ownerUid: partnerUid, ownerRole: owner.role, durationMonths: trial ? 0 : durationYears * 12,
        trial, trialUntil: trial ? Timestamp.fromMillis(trialUntilMillis) : null,
        activatedAt: Timestamp.fromMillis(activatedAtMillis), expiresAt, graceUntil,
        createdAt: stamp(), createdBy: actor.uid, createdByName: creatorName,
        createdByEmail: creatorEmail, portalProfileId: profileId });
      tx.create(assignmentRef, { deviceHash: pairing.deviceHash, licenseId, ownerUid: partnerUid, portalProfileId: profileId,
        deviceTokenHash: pairing.deviceTokenHash, platform: pairing.platform, portalMac: portalMac || null, customerLabel: label,
        providerName: cleanText(owner.displayName, 100), active: true, createdAt: stamp(), updatedAt: stamp(), lastSyncedAt: stamp(), createdBy: actor.uid });
      tx.create(keyRef.collection('devices').doc(pairing.deviceHash), { active: true, platform: pairing.platform,
        registeredAt: stamp(), lastSeen: stamp(), deleteAt: Timestamp.fromMillis((graceUntilMillis || trialUntilMillis) + 365 * 24 * 60 * 60 * 1000) });
      result = { existingLicense: false, trial, trialDays: trial ? 7 : undefined, creditsUsed: trial ? 0 : durationYears, remainingCredits: trial ? balance : balance - durationYears, durationYears: trial ? 0 : durationYears };
    }
    tx.update(codeRef, { state: 'completed', providerUid: partnerUid, ownerUid: partnerUid, pairedByUid: actor.uid, profileId, assignmentId: pairing.deviceHash,
      licenseId, completedAt: stamp() });
    result = { ...result, deviceId: pairing.deviceHash, portalMac: portalMac || null, licenseId, expiresAt: expiresAt?.toDate?.().toISOString?.() || null,
      graceUntil: graceUntil?.toDate?.().toISOString?.() || null, trial, trialExpiresAt: trial ? expiresAt.toDate().toISOString() : null, ownerUid: partnerUid, ownerRole: owner.role,
      ownerName: cleanText(owner.displayName, 100) };
  });
  await auditEvent(actor.uid, 'device_paired', result.licenseId, { profileId, ownerUid: partnerUid, existingLicense: result.existingLicense });
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
  if (!keySnap.exists || !profileSnap.exists || !portalProfileIsActive(profileSnap.data())) return res.status(403).json({ error: 'License or portal assignment is unavailable.' });
  if (keySnap.data().trial === true && keySnap.data().trialUntil?.toMillis?.() <= Date.now()) return res.status(403).json({ registered: false, error: 'The 7-day app trial has ended. Ask your partner to activate a license.', code: 'trial_expired' });
  return res.status(200).json({ state: 'completed', ...publicAssignment(keySnap.data(), profileSnap.data()) });
}

async function cancelPairing(req, res) {
  const deviceId = cleanText(req.body?.deviceId, 128), code = cleanText(req.body?.pairingCode, 20).toUpperCase();
  const token = cleanText(req.body?.deviceToken, 200);
  if (!deviceId || !token || !/^[A-F0-9]{12}$/.test(code)) return res.status(400).json({ error: 'Device ID, device token, and valid pairing code are required.' });
  const codeRef = pairingCodes.doc(sha256(code));
  const codeSnap = await codeRef.get();
  if (!codeSnap.exists || codeSnap.data().deviceHash !== sha256(deviceId)) return res.status(404).json({ error: 'Pairing request was not found.' });
  if (codeSnap.data().deviceTokenHash !== sha256(token)) return res.status(403).json({ error: 'Pairing request is not authorized for this device.' });
  await db.runTransaction(async tx => {
    const latest = await tx.get(codeRef);
    if (latest.exists && latest.data().state === 'pending') tx.update(codeRef, { state: 'cancelled', cancelledAt: stamp() });
  });
  return res.status(200).json({ cancelled: true });
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
  if (!keySnap.exists || keySnap.data().active !== true || !profileSnap.exists || !portalProfileIsActive(profileSnap.data())) return res.status(403).json({ registered: false, error: 'License or portal assignment is unavailable.', code: 'license_invalid' });
  if (keySnap.data().trial === true && keySnap.data().trialUntil?.toMillis?.() <= Date.now()) return res.status(403).json({ registered: false, error: 'The 7-day app trial has ended. Ask your partner to activate a license.', code: 'trial_expired' });
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
  if (method === 'POST' && route === '/api/pairing/cancel') return cancelPairing(req, res);
  if (method === 'POST' && route === '/api/device/sync') return syncDevice(req, res);
  return null;
}

callables.partnerCompletePairing = onCall({ region }, completePairing);

module.exports = { callables, handleAppApi, addMonthsUtc };
