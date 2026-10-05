const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const { createHash } = require('node:crypto');

// Deletion removes operational records, never the credit ledger or audit history.
// Preview and commit use the same transaction reads so newly added children,
// customers, or a changed balance must be reviewed again before deletion.
const db = admin.firestore();
const auth = admin.auth();
const region = 'northamerica-northeast1';
const stamp = () => FieldValue.serverTimestamp();
const fail = (code, message) => { throw new HttpsError(code, message); };
const hash = value => createHash('sha256').update(value).digest('hex');

async function requireAdmin(request) {
  if (!request.auth?.uid) fail('unauthenticated', 'Sign in to continue.');
  const snap = await db.collection('admins').doc(request.auth.uid).get();
  if (!snap.exists || snap.data().active === false || (snap.data().role && snap.data().role !== 'admin')) {
    fail('permission-denied', 'Admin access is required.');
  }
}

function target(request) {
  const kind = request.data?.kind;
  const id = String(request.data?.targetId || '');
  if (!['account', 'customer'].includes(kind) || !id || id.length > 128 || id.includes('/')) {
    fail('invalid-argument', 'Choose a partner account or customer to delete.');
  }
  return { kind, id };
}

async function readPlan(tx, kind, id) {
  const documents = new Map(), accountDocs = new Map(), customerDocs = new Map(), profileDocs = new Map();
  const include = doc => { if (doc.exists) documents.set(doc.ref.path, doc); };
  const collectCustomers = snap => snap.docs.forEach(doc => { include(doc); customerDocs.set(doc.id, doc); });
  let root, survivingParent = null;
  if (kind === 'account') {
    root = await tx.get(db.collection('partnerAccounts').doc(id));
    if (!root.exists) fail('not-found', 'Partner account was not found.');
    let frontier = [root];
    while (frontier.length) {
      const next = [];
      for (const doc of frontier) {
        if (accountDocs.has(doc.id)) continue;
        if (!['distributor', 'reseller', 'provider'].includes(doc.data().role)) fail('failed-precondition', 'Choose a partner account.');
        accountDocs.set(doc.id, doc); include(doc);
        const [children, customers, profiles, keys] = await Promise.all([
          tx.get(db.collection('partnerAccounts').where('parentUid', '==', doc.id)),
          tx.get(db.collection('deviceAssignments').where('ownerUid', '==', doc.id)),
          tx.get(db.collection('portalProfiles').where('ownerUid', '==', doc.id)),
          tx.get(db.collection('registrationKeys').where('ownerUid', '==', doc.id))
        ]);
        next.push(...children.docs);
        collectCustomers(customers);
        profiles.docs.forEach(profile => { include(profile); profileDocs.set(profile.id, profile); });
        keys.docs.forEach(include);
      }
      frontier = next;
    }
    const parentUid = root.data().parentUid;
    if (parentUid && !accountDocs.has(parentUid)) {
      const parent = await tx.get(db.collection('partnerAccounts').doc(parentUid));
      if (parent.exists) survivingParent = parent;
    }
  } else {
    root = await tx.get(db.collection('deviceAssignments').doc(id));
    if (!root.exists) fail('not-found', 'Customer assignment was not found.');
    include(root); customerDocs.set(root.id, root);
  }
  for (const customer of customerDocs.values()) {
    const licenseId = customer.data().licenseId;
    if (licenseId) include(await tx.get(db.collection('registrationKeys').doc(licenseId)));
    const codes = await tx.get(db.collection('pairingCodes').where('deviceHash', '==', customer.id));
    for (const code of codes.docs) {
      include(code);
      if (code.data().licenseId) include(await tx.get(db.collection('registrationKeys').doc(code.data().licenseId)));
    }
    include(await tx.get(db.collection('pairingRequests').doc(customer.id)));
  }
  const keyDocs = [...documents.values()].filter(doc => doc.ref.parent.id === 'registrationKeys');
  for (const key of keyDocs) {
    // Include every device, including disabled ones, to avoid orphan subcollections.
    const devices = await tx.get(key.ref.collection('devices'));
    devices.docs.forEach(include);
  }
  let credits = 0;
  for (const doc of accountDocs.values()) {
    const balance = doc.data().credits;
    if (!Number.isSafeInteger(balance) || balance < 0) fail('failed-precondition', 'Invalid credit balance. Resolve it through the ledger before deleting.');
    credits += balance;
  }
  if (!Number.isSafeInteger(credits)) fail('failed-precondition', 'Invalid branch credit total.');
  if (survivingParent && (!Number.isSafeInteger(survivingParent.data().credits) || survivingParent.data().credits < 0 ||
      !Number.isSafeInteger(survivingParent.data().credits + credits))) fail('failed-precondition', 'Invalid parent credit balance.');
  // Device heartbeats do not change the destructive scope. Meaningful changes do.
  const fingerprintFields = ['role', 'parentUid', 'credits', 'ownerUid', 'licenseId', 'portalProfileId',
    'customerLabel', 'displayName', 'active', 'archived', 'revision', 'expiresAt', 'trial', 'state', 'deviceTokenHash'];
  const fingerprintRows = [...documents.values(), ...(survivingParent ? [survivingParent] : [])]
    .sort((a, b) => a.ref.path.localeCompare(b.ref.path)).map(doc => {
      const data = doc.data();
      return [doc.ref.path, fingerprintFields.map(field => data[field] ?? null)];
    });
  const summary = { kind, targetId: id,
    label: root.data().displayName || root.data().customerLabel || id,
    accounts: accountDocs.size, customers: customerDocs.size, profiles: profileDocs.size,
    credits, creditsReturnedTo: survivingParent ? survivingParent.data().displayName || survivingParent.id : 'Admin allocation',
    confirmationToken: hash(JSON.stringify([kind, id, fingerprintRows])) };
  return { summary, documents, accountDocs, customerDocs, survivingParent };
}

async function finishAuthCleanup(receiptRef) {
  const receipt = (await receiptRef.get()).data();
  const pending = [];
  for (const uid of receipt.authPending || []) {
    try { await auth.deleteUser(uid); }
    catch (error) { if (error.code !== 'auth/user-not-found') pending.push(uid); }
  }
  await receiptRef.update({ authPending: pending, authCleanupPending: pending.length > 0, updatedAt: stamp() });
  return { deleted: true, ...receipt.summary, authCleanupPending: pending.length };
}

module.exports = {
  adminPreviewDeletion: onCall({ region, timeoutSeconds: 300 }, async request => {
    await requireAdmin(request);
    const { kind, id } = target(request);
    if (kind === 'account' && id === request.auth.uid) fail('failed-precondition', 'You cannot delete your own signed-in account.');
    return db.runTransaction(async tx => (await readPlan(tx, kind, id)).summary);
  }),
  adminDeleteRecord: onCall({ region, timeoutSeconds: 300 }, async request => {
    await requireAdmin(request);
    const { kind, id } = target(request);
    if (kind === 'account' && id === request.auth.uid) fail('failed-precondition', 'You cannot delete your own signed-in account.');
    if (request.data?.confirmation !== 'DELETE') fail('invalid-argument', 'Type DELETE to confirm permanent deletion.');
    const confirmationToken = request.data?.confirmationToken;
    if (!/^[a-f0-9]{64}$/.test(confirmationToken || '')) fail('invalid-argument', 'Review the deletion details first.');
    const receiptRef = db.collection('platformDeletions').doc(hash(`${kind}:${id}:${confirmationToken}`));
    await db.runTransaction(async tx => {
      const receipt = await tx.get(receiptRef);
      if (receipt.exists) {
        if (receipt.data().summary.confirmationToken !== request.data?.confirmationToken) fail('failed-precondition', 'Review this deletion again.');
        return;
      }
      const plan = await readPlan(tx, kind, id);
      if (request.data?.confirmationToken !== plan.summary.confirmationToken) {
        fail('failed-precondition', 'This account or customer changed. Review the updated deletion details before confirming.');
      }
      // Outstanding credits are returned, with the debit and ledger in this commit.
      // Paid license credits stay spent; deleting customers does not mint refunds.
      for (const account of plan.accountDocs.values()) {
        tx.set(db.collection('deletedPartnerAccounts').doc(account.id), { displayName: account.data().displayName || account.id,
          role: account.data().role, parentUid: account.data().parentUid || null, deletedAt: stamp(), deletedBy: request.auth.uid });
        const amount = account.data().credits;
        if (!amount) continue;
        tx.create(db.collection('creditLedger').doc(), plan.survivingParent
          ? { type: 'transfer', fromUid: account.id, toUid: plan.survivingParent.id, amount,
            reason: 'account_deletion', fromName: account.data().displayName || account.id,
            toName: plan.survivingParent.data().displayName || plan.survivingParent.id, actorUid: request.auth.uid, createdAt: stamp() }
          : { type: 'admin_adjustment', fromUid: account.id, toUid: null, amount, delta: -amount,
            reason: 'account_deletion', fromName: account.data().displayName || account.id,
            actorUid: request.auth.uid, createdAt: stamp() });
      }
      if (plan.survivingParent && plan.summary.credits) tx.update(plan.survivingParent.ref,
        { credits: plan.survivingParent.data().credits + plan.summary.credits, updatedAt: stamp() });
      for (const customer of plan.customerDocs.values()) {
        // Keep only the hashed device history; deleting/re-pairing cannot reset trials.
        tx.set(db.collection('deletedCustomerDevices').doc(customer.id), { previouslyPaired: true, deletedAt: stamp() }, { merge: true });
      }
      for (const doc of plan.documents.values()) tx.delete(doc.ref);
      tx.create(receiptRef, { summary: plan.summary, actorUid: request.auth.uid, authCleanupPending: plan.accountDocs.size > 0,
        authPending: [...plan.accountDocs.keys()], createdAt: stamp() });
      tx.create(db.collection('platformAudit').doc(), { type: `admin_${kind}_deleted`, actorUid: request.auth.uid,
        targetUid: id, detail: plan.summary, createdAt: stamp() });
    });
    // Firebase Auth cannot join a Firestore transaction. The durable receipt makes
    // this cleanup retryable; deleted accounts cannot authorize with cached tokens.
    return finishAuthCleanup(receiptRef);
  })
};
