const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const admin = require('firebase-admin');
const { Timestamp } = require('firebase-admin/firestore');

const projectId = process.env.GCLOUD_PROJECT || 'demo-stbpplatform';
const region = 'northamerica-northeast1';
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST || '127.0.0.1:5001';
const app = admin.initializeApp({ projectId }, `partner-emulator-tests-${Date.now()}`);
const db = admin.firestore(app);
const auth = admin.auth(app);
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const assertSame = (actual, expected, message) => assert.equal(actual, expected, message);

class CallableFailure extends Error {
  constructor(functionName, payload) {
    super(payload?.error?.message || `${functionName} returned HTTP error`);
    this.name = 'CallableFailure';
    this.code = payload?.error?.status || '';
  }
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const payload = await response.json();
  return { response, payload };
}

async function signIn(email, password) {
  const { response, payload } = await postJson(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-test-key`,
    { email, password, returnSecureToken: true }
  );
  assert(response.ok, `Auth emulator sign-in failed: ${JSON.stringify(payload)}`);
  return payload.idToken;
}

async function invoke(functionName, token, data = {}) {
  const { response, payload } = await postJson(
    `http://${functionsHost}/${projectId}/${region}/${functionName}`,
    { data },
    { Authorization: `Bearer ${token}` }
  );
  if (!response.ok || payload.error) throw new CallableFailure(functionName, payload);
  return payload.result ?? payload.data;
}

async function expectCallableError(promise, text) {
  let error;
  try { await promise; } catch (caught) { error = caught; }
  assert(error instanceof CallableFailure, `Expected a callable failure containing “${text}”.`);
  assert.match(error.message, new RegExp(text, 'i'));
  return error;
}

async function createSignedInUser({ email, name, password = 'Emulator-test-47!A' }) {
  const user = await auth.createUser({ email, displayName: name, password });
  return { uid: user.uid, email, name, password, token: await signIn(email, password) };
}

async function signInPartner(uid, email, name) {
  const password = `Partner-${randomBytes(8).toString('hex')}!A7`;
  await auth.updateUser(uid, { password, displayName: name });
  return { uid, email, name, password, token: await signIn(email, password) };
}

async function account(uid) {
  const snap = await db.collection('partnerAccounts').doc(uid).get();
  assert(snap.exists, `Partner account ${uid} should exist.`);
  return snap.data();
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

async function createPortal(token, ownerName, suffix, expiresAt = null) {
  return invoke('partnerCreatePortalProfile', token, {
    name: `${ownerName} ${suffix}`,
    portalUrl: `https://${suffix.toLowerCase()}-${ownerName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example.test/service`,
    expiresAt
  });
}

async function seedPairing(deviceName, existingDeviceId = null) {
  const deviceId = existingDeviceId || `emulator-device-${deviceName}-${randomBytes(5).toString('hex')}`;
  const deviceToken = randomBytes(24).toString('hex');
  const pairingCode = randomBytes(6).toString('hex').toUpperCase();
  const deviceHash = hash(deviceId);
  await db.collection('pairingCodes').doc(hash(pairingCode)).set({
    deviceHash,
    platform: 'android',
    portalMac: 'AA:BB:CC:DD:EE:01',
    deviceTokenHash: hash(deviceToken),
    createdAt: Timestamp.now(),
    expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
    state: 'pending'
  });
  return { deviceId, deviceHash, deviceToken, pairingCode };
}

async function pair(partner, profileId, label, years, seeded = null) {
  const pairing = seeded || await seedPairing(label);
  const result = await invoke('partnerCompletePairing', partner.token, {
    pairingCode: pairing.pairingCode,
    profileId,
    customerLabel: label,
    durationYears: years
  });
  return { ...pairing, result };
}

async function syncDevice(pairing) {
  const { response, payload } = await postJson(
    `http://${functionsHost}/${projectId}/${region}/appApi/api/device/sync`,
    { deviceId: pairing.deviceId, deviceToken: pairing.deviceToken, platform: 'android', appVersion: '2.0.2' }
  );
  assert(response.ok, `Device sync failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function test() {
  assert(process.env.FIRESTORE_EMULATOR_HOST, 'Run this suite through firebase emulators:exec.');
  const adminUser = await createSignedInUser({ email: 'platform-admin@example.test', name: 'Platform Admin' });
  await db.collection('admins').doc(adminUser.uid).set({ active: true, role: 'admin' });

  const distributorResult = await invoke('adminCreateDistributor', adminUser.token, {
    displayName: 'Distributor One', email: 'distributor-one@example.test', credits: 500
  });
  const distributor = await signInPartner(distributorResult.uid, 'distributor-one@example.test', 'Distributor One');
  const resellerResult = await invoke('partnerCreateChild', distributor.token, {
    displayName: 'Reseller One', email: 'reseller-one@example.test', role: 'reseller', credits: 20
  });
  const reseller = await signInPartner(resellerResult.uid, 'reseller-one@example.test', 'Reseller One');
  const providerResult = await invoke('partnerCreateChild', reseller.token, {
    displayName: 'Provider One', email: 'provider-one@example.test', role: 'provider', credits: 20
  });
  const provider = await signInPartner(providerResult.uid, 'provider-one@example.test', 'Provider One');
  assert.equal((await invoke('partnerListDashboard', distributor.token)).transferRules.distributorToResellerMax, 250);
  assert.equal((await invoke('partnerListDashboard', reseller.token)).transferRules.resellerToProviderMin, 20);

  const providerPortalA = await createPortal(provider.token, provider.name, 'A');
  const providerPortalB = await createPortal(provider.token, provider.name, 'B');
  const providerPairing = await pair(provider, providerPortalA.profileId, 'Provider customer', 1);
  const providerKeyId = providerPairing.result.licenseId;
  const providerKeyRef = db.collection('registrationKeys').doc(providerKeyId);
  let providerKey = (await providerKeyRef.get()).data();
  assert.equal(providerKey.durationMonths, 12);
  assert.equal(providerKey.graceUntil.toMillis(), providerKey.expiresAt.toMillis() + 7 * 24 * 60 * 60 * 1000);
  const providerWorkspace = await invoke('partnerProviderDashboard', provider.token);
  assert.equal(providerWorkspace.customers.length, 1);
  assert.equal(providerWorkspace.customers[0].keyHint, providerKey.keyHint);
  assert.equal(providerWorkspace.customers[0].durationYears, 1);

  const balancesAfterOneYearActivation = await Promise.all([distributor.uid, reseller.uid, provider.uid].map(account));
  assertSame(balancesAfterOneYearActivation[0].credits, 480, 'Distributor retains 480 after allocating 20 credits.');
  assertSame(balancesAfterOneYearActivation[1].credits, 0, 'Reseller retains 0 after transferring 20 credits to Provider.');
  assertSame(balancesAfterOneYearActivation[2].credits, 19, 'Provider retains 19 after a one-year activation.');
  let ledgerRows = (await db.collection('creditLedger').get()).docs.map(doc => doc.data());
  assert(ledgerRows.some(row => row.type === 'transfer' && row.fromUid === distributor.uid && row.toUid === reseller.uid && row.amount === 20));
  assert(ledgerRows.some(row => row.type === 'transfer' && row.fromUid === reseller.uid && row.toUid === provider.uid && row.amount === 20));
  assert(ledgerRows.some(row => row.type === 'license_issued' && row.fromUid === provider.uid && row.toUid === providerPairing.deviceHash && row.amount === 1 && row.durationYears === 1));

  const dashboard = await invoke('partnerListDashboard', adminUser.token);
  assert.equal(dashboard.creditSummary, undefined, 'The partner list endpoint stays independent from optional Admin credit totals.');
  const creditSummary = await invoke('adminCreditSummary', adminUser.token);
  assert.deepEqual(creditSummary, {
    allocated: 500, adjustmentNet: 0, used: 1, transferred: 40, held: 499, reconciliation: 0
  }, 'Admin credit overview reconciles issued credits, license use, transfers, and current partner balances.');
  await expectCallableError(invoke('adminCreditSummary', distributor.token), 'Admin access is required');
  const resellerRow = dashboard.accounts.find(row => row.uid === reseller.uid);
  const providerRow = dashboard.accounts.find(row => row.uid === provider.uid);
  assert.equal(resellerRow.createdByName, distributor.name);
  assert.equal(providerRow.createdByName, reseller.name);
  assert.equal(providerRow.parentName, reseller.name);
  assert(dashboard.recentActivity.some(row => row.toName === 'Provider customer'), 'Admin activity shows a customer label for license events.');

  const adminCustomerDashboard = await invoke('adminProviderDashboard', adminUser.token);
  const adminProviderCustomer = adminCustomerDashboard.customers.find(row => row.deviceId === providerPairing.deviceHash);
  assert.equal(adminProviderCustomer.createdByName, provider.name);
  assert.equal(adminProviderCustomer.parentName, reseller.name);
  assert.equal(adminProviderCustomer.parentUid, reseller.uid);

  await invoke('partnerSwitchDevicePortal', provider.token, { deviceRef: providerPairing.deviceHash, profileId: providerPortalB.profileId });
  const syncedProvider = await syncDevice(providerPairing);
  assert.equal(syncedProvider.portal.url, `https://b-provider-one.example.test/service`);
  assert.equal(syncedProvider.portal.name, 'Provider One B');
  await expectCallableError(
    invoke('partnerSwitchDevicePortal', provider.token, { deviceRef: providerPairing.deviceHash, profileId: (await createPortal(distributor.token, distributor.name, 'A')).profileId }),
    'owned by your account'
  );
  const expiredProfileId = `expired-${randomBytes(8).toString('hex')}`;
  await db.collection('portalProfiles').doc(expiredProfileId).set({ ownerUid: provider.uid, name: 'Expired provider portal',
    portalUrl: 'https://expired.example.test/service', active: true, revision: 1,
    expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
  await expectCallableError(
    invoke('partnerSwitchDevicePortal', provider.token, { deviceRef: providerPairing.deviceHash, profileId: expiredProfileId }),
    'active portal profile'
  );

  const invalidActivation = await seedPairing('invalid-duration');
  const creditsBeforeInvalidActivation = (await account(provider.uid)).credits;
  await expectCallableError(invoke('partnerCompletePairing', provider.token, {
    pairingCode: invalidActivation.pairingCode, profileId: providerPortalA.profileId, customerLabel: 'Invalid duration', durationYears: 11
  }), '1 to 10 years');
  await expectCallableError(invoke('partnerCompletePairing', provider.token, {
    pairingCode: invalidActivation.pairingCode, profileId: providerPortalA.profileId, customerLabel: 'Fractional duration', durationYears: 1.5
  }), '1 to 10 years');
  assert.equal((await account(provider.uid)).credits, creditsBeforeInvalidActivation);

  await expectCallableError(invoke('partnerRenewDeviceLicense', provider.token, { deviceRef: providerPairing.deviceHash, years: 11 }), '1 to 10 years');
  await expectCallableError(invoke('partnerRenewDeviceLicense', provider.token, { deviceRef: providerPairing.deviceHash, years: 1.5 }), '1 to 10 years');
  assert.equal((await account(provider.uid)).credits, creditsBeforeInvalidActivation);
  assert.equal((await providerKeyRef.get()).data().expiresAt.toMillis(), providerKey.expiresAt.toMillis(), 'Rejected renewal terms do not extend the license.');
  const oldExpiry = providerKey.expiresAt.toMillis();
  const renewal = await invoke('partnerRenewDeviceLicense', provider.token, { deviceRef: providerPairing.deviceHash, years: 3 });
  providerKey = (await providerKeyRef.get()).data();
  assert.equal(renewal.durationYears, 3);
  assert.equal(providerKey.durationMonths, 48);
  assert.equal(providerKey.expiresAt.toMillis(), addMonthsUtc(oldExpiry, 36));
  assert.equal(providerKey.graceUntil.toMillis(), providerKey.expiresAt.toMillis() + 7 * 24 * 60 * 60 * 1000);
  ledgerRows = (await db.collection('creditLedger').get()).docs.map(doc => doc.data());
  assert(ledgerRows.some(row => row.type === 'license_renewal' && row.fromUid === provider.uid && row.toUid === providerPairing.deviceHash && row.amount === 3 && row.durationYears === 3));

  const distributorPortalA = await createPortal(distributor.token, distributor.name, 'A');
  const distributorPortalB = await createPortal(distributor.token, distributor.name, 'B');
  const distributorBeforeCustomerActivation = (await account(distributor.uid)).credits;
  const distributorPairing = await pair(distributor, distributorPortalA.profileId, 'Distributor customer', 10);
  assert.equal((await account(distributor.uid)).credits, distributorBeforeCustomerActivation - 10, 'A Distributor customer activation deducts one credit per license year.');
  const distributorKey = (await db.collection('registrationKeys').doc(distributorPairing.result.licenseId).get()).data();
  const distributorActivation = distributorKey.activatedAt.toMillis();
  assert.equal(distributorKey.durationMonths, 120);
  assert.equal(distributorKey.expiresAt.toMillis(), addMonthsUtc(distributorActivation, 120));
  assert.equal(distributorKey.graceUntil.toMillis(), distributorKey.expiresAt.toMillis() + 7 * 24 * 60 * 60 * 1000);
  const distributorBeforeReassignment = (await account(distributor.uid)).credits;
  const distributorRePairing = await seedPairing('distributor-existing-customer', distributorPairing.deviceId);
  const distributorRePairResult = await invoke('partnerCompletePairing', distributor.token, {
    pairingCode: distributorRePairing.pairingCode, profileId: distributorPortalA.profileId,
    customerLabel: 'Distributor customer', durationYears: 1
  });
  assert.equal(distributorRePairResult.existingLicense, true);
  assert.equal(distributorRePairResult.creditsUsed, 0);
  assert.equal(distributorRePairResult.remainingCredits, distributorBeforeReassignment);
  assert.equal((await account(distributor.uid)).credits, distributorBeforeReassignment, 'Reassigning the same licensed device does not charge twice.');
  await invoke('partnerSwitchDevicePortal', distributor.token, { deviceRef: distributorPairing.deviceHash, profileId: distributorPortalB.profileId });
  assert.equal((await syncDevice(distributorRePairing)).portal.name, 'Distributor One B');

  const distributorProfiles = await invoke('adminListPairingProfiles', adminUser.token, { partnerUid: distributor.uid });
  assert.equal(distributorProfiles.partner.credits, distributorBeforeCustomerActivation - 10);
  assert(distributorProfiles.profiles.some(profile => profile.id === distributorPortalA.profileId));
  await expectCallableError(invoke('adminListPairingProfiles', distributor.token, { partnerUid: distributor.uid }), 'Admin access is required');
  const invalidAdminPairing = await seedPairing('admin-invalid-profile-owner');
  const distributorBeforeRejectedAdminPair = (await account(distributor.uid)).credits;
  await expectCallableError(invoke('partnerCompletePairing', adminUser.token, {
    partnerUid: distributor.uid, pairingCode: invalidAdminPairing.pairingCode,
    profileId: providerPortalA.profileId, customerLabel: 'Wrong profile owner', durationYears: 1
  }), 'owned by the selected partner account');
  assert.equal((await account(distributor.uid)).credits, distributorBeforeRejectedAdminPair, 'An Admin pairing with another partner\'s profile does not charge credits.');

  const adminPairing = await seedPairing('admin-created-customer');
  const distributorBeforeAdminPair = (await account(distributor.uid)).credits;
  const adminPairResult = await invoke('partnerCompletePairing', adminUser.token, {
    partnerUid: distributor.uid, pairingCode: adminPairing.pairingCode,
    profileId: distributorPortalB.profileId, customerLabel: 'Admin-added customer', durationYears: 2
  });
  assert.equal(adminPairResult.ownerUid, distributor.uid);
  assert.equal(adminPairResult.ownerRole, 'distributor');
  assert.equal(adminPairResult.creditsUsed, 2);
  assert.equal((await account(distributor.uid)).credits, distributorBeforeAdminPair - 2, 'Admin-added customer licenses debit the selected partner atomically.');
  ledgerRows = (await db.collection('creditLedger').where('type', '==', 'license_issued').get()).docs.map(doc => doc.data());
  assert(ledgerRows.some(row => row.fromUid === distributor.uid && row.toUid === adminPairing.deviceHash && row.amount === 2 && row.actorUid === adminUser.uid), 'Admin pairing is attributed to Admin while charging the selected partner.');
  const distributorWorkspaceAfterAdminPair = await invoke('partnerProviderDashboard', distributor.token);
  assert(distributorWorkspaceAfterAdminPair.customers.some(row => row.deviceRef === adminPairing.deviceHash), 'Admin-created customers appear in the selected partner workspace.');
  const adminDashboardAfterPair = await invoke('adminProviderDashboard', adminUser.token);
  const adminAddedCustomer = adminDashboardAfterPair.customers.find(row => row.deviceId === adminPairing.deviceHash);
  assert.equal(adminAddedCustomer.partnerRole, 'distributor');
  assert.equal(adminAddedCustomer.createdByName, adminUser.name);

  const distributorBeforeTransfer = (await account(distributor.uid)).credits;
  const resellerBeforeTransfer = (await account(reseller.uid)).credits;
  const transferRowsBefore = (await db.collection('creditLedger').where('type', '==', 'transfer').get()).size;
  await expectCallableError(invoke('partnerTransferCredits', distributor.token, { targetUid: reseller.uid, amount: 251 }), 'Maximum reseller allocation is 250');
  assert.equal((await account(distributor.uid)).credits, distributorBeforeTransfer, 'A rejected over-limit transfer leaves the Distributor balance unchanged.');
  assert.equal((await account(reseller.uid)).credits, resellerBeforeTransfer, 'A rejected over-limit transfer leaves the Reseller balance unchanged.');
  assert.equal((await db.collection('creditLedger').where('type', '==', 'transfer').get()).size, transferRowsBefore, 'A rejected transfer does not add a ledger row.');
  await invoke('partnerTransferCredits', distributor.token, { targetUid: reseller.uid, amount: 20 });
  assert.equal((await account(distributor.uid)).credits, distributorBeforeTransfer - 20);
  assert.equal((await account(reseller.uid)).credits, resellerBeforeTransfer + 20);
  ledgerRows = (await db.collection('creditLedger').where('type', '==', 'transfer').get()).docs.map(doc => doc.data());
  assert(ledgerRows.some(row => row.fromUid === distributor.uid && row.toUid === reseller.uid && row.amount === 20), 'The Distributor → Reseller transfer is ledgered atomically.');
  const resellerPortalA = await createPortal(reseller.token, reseller.name, 'A');
  const resellerPortalB = await createPortal(reseller.token, reseller.name, 'B');
  const resellerPairing = await pair(reseller, resellerPortalA.profileId, 'Reseller customer', 1);
  assert.equal((await account(reseller.uid)).credits, 19);
  await invoke('partnerSwitchDevicePortal', reseller.token, { deviceRef: resellerPairing.deviceHash, profileId: resellerPortalB.profileId });
  assert.equal((await syncDevice(resellerPairing)).portal.name, 'Reseller One B');

  const roleResellerResult = await invoke('partnerCreateChild', distributor.token, {
    displayName: 'Role Test Reseller', email: 'role-reseller@example.test', role: 'reseller', credits: 0
  });
  const roleReseller = await signInPartner(roleResellerResult.uid, 'role-reseller@example.test', 'Role Test Reseller');
  await invoke('partnerTransferCredits', distributor.token, { targetUid: roleReseller.uid, amount: 20 });
  const roleProviderResult = await invoke('partnerCreateChild', roleReseller.token, {
    displayName: 'Role Test Provider', email: 'role-provider@example.test', role: 'provider', credits: 20
  });
  const roleProvider = await signInPartner(roleProviderResult.uid, 'role-provider@example.test', 'Role Test Provider');
  await invoke('partnerSetAccountRole', adminUser.token, { targetUid: roleProvider.uid, newRole: 'reseller', newParentUid: distributor.uid });
  assert.equal((await account(roleProvider.uid)).role, 'reseller');
  await invoke('partnerSetAccountRole', distributor.token, { targetUid: roleProvider.uid, newRole: 'provider', newParentUid: reseller.uid });
  assert.equal((await account(roleProvider.uid)).parentUid, reseller.uid);
  await expectCallableError(
    invoke('partnerSetAccountRole', adminUser.token, { targetUid: roleProvider.uid, newRole: 'reseller', newParentUid: reseller.uid }),
    'must be under a distributor'
  );
  const blockedRoleChange = await expectCallableError(
    invoke('partnerSetAccountRole', adminUser.token, { targetUid: reseller.uid, newRole: 'distributor', newParentUid: null }),
    'child accounts'
  );
  assert.match(blockedRoleChange.message, /Provider One/i, 'A blocked role change identifies the incompatible child account.');
  assert.equal((await account(reseller.uid)).role, 'reseller', 'Role changes with incompatible child accounts leave the role unchanged.');

  const outsiderDistResult = await invoke('adminCreateDistributor', adminUser.token, {
    displayName: 'Outside Distributor', email: 'outside-distributor@example.test', credits: 500
  });
  const outsiderDist = await signInPartner(outsiderDistResult.uid, 'outside-distributor@example.test', 'Outside Distributor');
  const outsiderResellerResult = await invoke('partnerCreateChild', outsiderDist.token, {
    displayName: 'Outside Reseller', email: 'outside-reseller@example.test', role: 'reseller', credits: 0
  });
  await expectCallableError(
    invoke('partnerSetAccountRole', distributor.token, { targetUid: outsiderResellerResult.uid, newRole: 'provider', newParentUid: reseller.uid }),
    'own branch'
  );

  const secondResellerResult = await invoke('partnerCreateChild', distributor.token, {
    displayName: 'Second Reseller', email: 'second-reseller@example.test', role: 'reseller', credits: 0
  });
  const secondReseller = await signInPartner(secondResellerResult.uid, 'second-reseller@example.test', 'Second Reseller');
  const transferAttempts = await Promise.allSettled([
    invoke('partnerTransferCredits', distributor.token, { targetUid: reseller.uid, amount: 250 }),
    invoke('partnerTransferCredits', distributor.token, { targetUid: secondReseller.uid, amount: 250 })
  ]);
  assert.equal(transferAttempts.filter(result => result.status === 'fulfilled').length, 1, 'Only one concurrent transfer can spend the available balance.');
  assert.equal(transferAttempts.filter(result => result.status === 'rejected').length, 1);
  assert((await account(distributor.uid)).credits >= 0, 'Concurrent transfers never make a balance negative.');
  ledgerRows = (await db.collection('creditLedger').get()).docs.map(doc => doc.data());
  assert.equal(ledgerRows.filter(row => row.type === 'transfer' && row.fromUid === distributor.uid && row.amount === 250).length, 1, 'The ledger has exactly one record for the successful concurrent transfer.');

  const manualKey = await invoke('adminCreateKey', adminUser.token, { label: 'Creator audit test', deviceLimit: 1, expiresAt: null });
  const adminDashboard = await invoke('adminListDashboard', adminUser.token);
  const manualKeyRow = adminDashboard.keys.find(row => row.keyHint === manualKey.keyHint);
  assert(manualKeyRow, 'The manual key appears in the Admin key list.');
  assert.equal(manualKeyRow.createdByRole, 'admin');
  assert.equal(manualKeyRow.createdByEmail, adminUser.email);
  assert(manualKeyRow.createdByName, 'Admin key creator has a readable name or email.');

  console.log('PASS: role scope/parent rules, child-role blocking, atomic concurrent transfers, partner pairing and portal switching, 1–10 year expiry/renewal, seven-day grace, ledger attribution, and customer sync.');
}

test().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  await app.delete();
});
