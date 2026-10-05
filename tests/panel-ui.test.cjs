const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
let playwright;
try { playwright = require('playwright'); }
catch { playwright = require(require.resolve('playwright', { paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES] })); }
const publicDir = path.resolve(__dirname, '../public');

// Execute the actual dashboard module and CSS. Stub only the Firebase transport;
// backend authorization and transactions are tested in the emulator suite.
const fixture = `
const auth = {}, functions = {};
window.__calls = [];
const role = window.__role;
const profiles = [
 {id:'a',name:'Primary portal',host:'primary.example.test',active:true,ownerUid:'owner'},
 {id:'b',name:'Backup portal',host:'backup.example.test',active:true,ownerUid:'owner'},
 {id:'foreign',name:'Different partner portal',host:'foreign.example.test',active:true,ownerUid:'other'},
 {id:'expired',name:'Expired portal',host:'expired.example.test',active:false,ownerUid:'owner'}
];
window.__customers = [1,2].map(n => ({
 deviceRef:String(n).repeat(64),deviceId:String(n).repeat(64),ownerUid:'owner',portalProfileId:'a',
 customerLabel:'Customer '+n,portalName:'Primary portal',portalHost:'primary.example.test',
 portalMac:'AA:BB:CC:DD:EE:01',platform:'windows',portalActive:true,active:true,licenseState:'active',
 licenseId:'key-'+n,licenseExpiresAt:'2027-10-05T12:00:00Z',providerName:'Partner account',parentName:'Distributor',partnerRole:'provider'
}));
window.__accounts = [{uid:'owner',displayName:'Partner account',email:'test@example.test',role:'distributor',credits:42,active:true}];
window.__pendingDeletions = [];
const httpsCallable = (_functions, name) => async (data = {}) => {
 window.__calls.push({name,data});
 const account = {uid:role==='admin'?'admin':'owner',role,credits:500,displayName:'Test '+role};
 if(name==='partnerListDashboard') return {data:{account,accounts:window.__accounts,pendingDeletions:window.__pendingDeletions,recentActivity:[],limits:{},transferRules:{}}};
 if(name==='partnerProviderDashboard') return {data:{account,customers:window.__customers,profiles:profiles.filter(p=>p.ownerUid==='owner')}};
 if(name==='adminProviderDashboard') return {data:{customers:window.__customers,profiles}};
 if(name==='adminListDashboard') return {data:{keys:[],devices:[],activeKeys:0,activeDevices:0,platformCounts:{android:0,windows:0},settings:{}}};
 if(name==='adminCreditSummary') return {data:{allocated:500,totalAllocated:500,used:0,held:500,reconciliation:0}};
 if(name==='partnerSwitchDevicePortal') {
   if(window.__failSwitch) throw new Error('Choose an active portal profile owned by the customer’s partner account.');
   const customer=window.__customers.find(c=>c.deviceRef===data.deviceRef);
   customer.portalProfileId=data.profileId;customer.portalName=profiles.find(p=>p.id===data.profileId).name;
   return {data:{updated:true}};
 }
 if(name==='adminPreviewDeletion') {
   window.__deletionPreview={kind:data.kind,targetId:data.targetId,label:'Partner account',accounts:data.kind==='account'?3:0,
     customers:2,profiles:3,credits:42,creditsReturnedTo:'Admin allocation',confirmationToken:'a'.repeat(64)};
   return {data:window.__deletionPreview};
 }
 if(name==='adminDeleteRecord') {
   if(data.kind==='customer')window.__customers=window.__customers.filter(c=>c.deviceRef!==data.targetId);
   else window.__accounts=window.__accounts.filter(a=>a.uid!==data.targetId);
   window.__pendingDeletions=window.__failAuthCleanup?[window.__deletionPreview]:[];
   return {data:{deleted:true,authCleanupPending:window.__failAuthCleanup?1:0}};
 }
 return {data:{}};
};
const onAuthStateChanged = (_auth, callback) => queueMicrotask(()=>callback({uid:role}));
const signInWithEmailAndPassword = async()=>{}, signOut = async()=>{};
`;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'app.js', 'style.css'].includes(filename)) { res.writeHead(404); res.end(); return; }
  let content = fs.readFileSync(path.join(publicDir, filename), 'utf8');
  if (filename === 'app.js') content = fixture + content.replace(/^import .*;\n/gm, '');
  res.setHeader('Content-Type', filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(content);
});

async function test() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = await playwright.chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox'] });
  try {
    for (const width of [1366, 390]) for (const role of ['admin', 'distributor', 'reseller', 'provider']) {
      const page = await browser.newPage({ viewport: { width, height: 960 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route(/https:\/\/.*/, route => route.abort());
      await page.addInitScript(role => window.__role = role, role);
      await page.goto(url);
      await page.locator('[data-admin-tab="customers"]').click();
      const root = role === 'admin' ? '#adminCustomerCards' : '#customerCards';
      const cards = page.locator(`${root} .customerCard`);
      await cards.first().locator('summary').click();
      await cards.nth(1).locator('summary').click();
      const select = cards.first().locator('[data-device-profile]');
      const button = cards.first().locator('[data-switch-portal]');
      assert.equal(await button.isDisabled(), true);
      assert.equal(await select.locator('option[value="foreign"]').count(), 0);
      assert.equal(await select.locator('option[value="expired"]').count(), 0);
      await select.selectOption('b');
      assert.equal(await button.isEnabled(), true);
      await button.click();
      await page.waitForFunction(() => window.__calls.some(call => call.name === 'partnerSwitchDevicePortal'));
      await page.waitForFunction(() => window.__customers[0].portalProfileId === 'b');
      assert.deepEqual(await page.evaluate(() => window.__calls.find(call => call.name === 'partnerSwitchDevicePortal').data),
        { deviceRef: '1'.repeat(64), profileId: 'b' });
      assert.equal(await page.evaluate(() => window.__customers[1].portalProfileId), 'a', 'Switch affects only the selected customer.');
      // Refresh replaces cards; reopen and verify the persisted selection.
      await page.waitForFunction(root => document.querySelector(root+' [data-device-profile]')?.value === 'b', root);
      await cards.first().locator('summary').click();
      assert.equal(await cards.first().locator('[data-device-profile]').inputValue(), 'b');
      // A failure is visible and the same control can retry.
      await page.evaluate(() => window.__failSwitch = true);
      await cards.first().locator('[data-device-profile]').selectOption('a');
      await cards.first().locator('[data-switch-portal]').click();
      await page.waitForFunction(root => document.querySelector(root+' [data-portal-message]')?.textContent.includes('Choose an active'), root);
      assert.equal(await cards.first().locator('[data-switch-portal]').isEnabled(), true);
      const bounds = await cards.first().locator('[data-device-profile]').boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width, `Portal dropdown fits ${role} at ${width}px.`);
      if (process.env.STBP_UI_SCREENSHOTS && role === 'admin') {
        fs.mkdirSync(process.env.STBP_UI_SCREENSHOTS, {recursive:true});
        await page.screenshot({path:path.join(process.env.STBP_UI_SCREENSHOTS, `admin-customers-${width}.png`),fullPage:true});
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      assert.equal(overflow, false, `No horizontal page overflow for ${role} at ${width}px.`);
      assert.deepEqual(errors, [], 'Dashboard has no uncaught JavaScript errors.');
      if (role === 'admin') {
        await cards.first().locator('[data-customer-delete]').click();
        assert.equal(await page.locator('#deleteDialog').isVisible(), true);
        assert.equal(await page.evaluate(() => window.__calls.filter(call=>call.name==='adminDeleteRecord').length), 0);
        await page.locator('[data-close-dialog="deleteDialog"]').click();
        assert.equal(await page.evaluate(() => window.__calls.filter(call=>call.name==='adminDeleteRecord').length), 0, 'Cancel never deletes.');
        await cards.first().locator('[data-customer-delete]').click();
        await page.locator('#deleteConfirmation').fill('wrong');
        await page.locator('#deleteForm [type="submit"]').click();
        assert.equal(await page.evaluate(() => window.__calls.filter(call=>call.name==='adminDeleteRecord').length), 0);
        await page.locator('#deleteConfirmation').fill('DELETE');
        await page.locator('#deleteForm [type="submit"]').click();
        await page.waitForFunction(() => window.__calls.some(call=>call.name==='adminDeleteRecord'));
        assert.equal(await page.evaluate(() => window.__calls.find(call=>call.name==='adminDeleteRecord').data.confirmation), 'DELETE');
        await page.waitForFunction(() => !document.querySelector('#deleteDialog').open);
        await page.locator('[data-admin-tab="partners"]').click();
        const deleteAccount = page.locator('[data-partner-action="delete"]:visible');
        if (width < 680) await page.locator('#accountsCards .accountCard > details.accountDetails').last().locator('summary').first().click();
        await deleteAccount.click();
        assert.match(await page.locator('#deleteSummary').textContent(), /3 partner account.*42 unused credits/);
        await page.evaluate(() => window.__failAuthCleanup = true);
        await page.locator('#deleteConfirmation').fill('DELETE');
        await page.locator('#deleteForm [type="submit"]').click();
        await page.waitForFunction(() => document.querySelector('#deleteSummary').textContent.includes('Some sign-in records'));
        await page.locator('[data-close-dialog="deleteDialog"]').click();
        await page.locator('#refreshPartner').click();
        await page.locator('[data-retry-deletion]').click();
        await page.evaluate(() => window.__failAuthCleanup = false);
        await page.locator('#deleteConfirmation').fill('DELETE');
        await page.locator('#deleteForm [type="submit"]').click();
        await page.waitForFunction(() => !document.querySelector('#deleteDialog').open);
        assert.equal(await page.evaluate(() => window.__pendingDeletions.length), 0, 'Auth cleanup remains retryable after closing the modal.');
      } else {
        assert.equal(await page.locator('[data-customer-delete]').count(), 0, 'Partners never get Admin delete actions.');
      }
      console.log(`PASS: ${role} desktop/mobile portal selection, switch, isolation, error retry and layout (${width}px).`);
      await page.close();
    }
    console.log('PASS: Admin deletion preview, cancel, typed confirmation, branch summary and pending Auth cleanup retry; no partner delete controls.');
  } finally { await browser.close(); }
}
test().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
