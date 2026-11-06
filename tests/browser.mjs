/** Actual static-export and Python-service interactions, with explicit test-only chain fixtures. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
const { chromium, webkit } = await import(process.env.IMD_PLAYWRIGHT || 'playwright');

await mkdir('test/scratch/browser/shots', { recursive: true });
const root = resolve('dist');
const mime = { '.js':'text/javascript', '.css':'text/css', '.html':'text/html', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.json':'application/json' };
const staticServer = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/preview/')) { res.writeHead(404).end(); return; }
    const path = resolve(root, url.pathname.slice(9) || 'index.html');
    if (!path.startsWith(root + '/')) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream'); res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => staticServer.listen(0, '127.0.0.1', done));
const staticURL = `http://127.0.0.1:${staticServer.address().port}/preview/`;
const backend = spawn('python3', ['tests/serve.py'], { stdio: ['pipe','pipe','pipe'] });
let stderr = ''; backend.stderr.on('data', data => { stderr += data; });
const lines = createInterface({ input: backend.stdout });
const pendingLines = [], waitingLines = [];
lines.on('line', line => { const item = waitingLines.shift(); if (item) item(JSON.parse(line)); else pendingLines.push(JSON.parse(line)); });
const nextLine = () => pendingLines.length ? Promise.resolve(pendingLines.shift()) : new Promise(done => waitingLines.push(done));
const ready = await Promise.race([nextLine(), new Promise((_, reject) => { const t=setTimeout(()=>reject(new Error('Test service startup timed out: '+stderr)),10000); t.unref(); })]);
const serverURL = `http://127.0.0.1:${ready.port}/`;
const advance = async seconds => { backend.stdin.write(JSON.stringify({ advance: seconds })+'\n'); await nextLine(); };
const browser = await chromium.launch({ headless: true, proxy: process.env.HTTP_PROXY ? { server: process.env.HTTP_PROXY, bypass: '127.0.0.1,localhost' } : undefined });
const errors = [], results = [], shots = [];
const core = () => ({ schemaVersion:1, installationId:'browser-test-only', status:'available', chain:{chainId:'11155111',safeThroughBlock:'120'}, core:{settledThroughRound:'800',cumulativeWork:'9007199254740993',blockHeight:'9',blockProgress:'0'}, source:{transactionHash:'0x'+'ab'.repeat(32),blockNumber:'100',blockTimestamp:'1793966400'} });
const status = () => ({ schemaVersion:1, installationId:'browser-test-only', generatedAt:new Date().toISOString(), builder:{status:'available'}, measurement:{freshness:'online',observedAt:new Date().toISOString(),staleAfterSeconds:120,coreStatus:'IDLE',rpmMilli:0,provenance:'hardware'},settlementQueue:{status:'available',latestSubmission:{lifecycle:'submitted',settledThroughRound:'801'}} });
const fixtures = async context => context.route('https://api.squeekchain.com/**', route => route.fulfill({ contentType:'application/json', body:JSON.stringify(route.request().url().endsWith('/core') ? core() : status()) }));
const context = async (width=390, fixture=true) => {
  const ctx = await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'});
  if (fixture) await fixtures(ctx);
  ctx.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  return ctx;
};
const test = async (name, action) => { try { const outcome=await action(); if(outcome==='skip'){results.push({name,passed:null,limitation:'WebKit binary is not installed in the supplied runtime.'});console.log('SKIP '+name);return;} results.push({name,passed:true}); console.log('PASS '+name); } catch (error) { results.push({name,passed:false,error:error.message}); console.log('FAIL '+name+': '+error.message); } };
const until = async (page, selector, text) => page.waitForFunction(([selector,text]) => document.querySelector(selector)?.textContent.includes(text), [selector,text],{timeout:10000});
const screenshot = async (page,name,fullPage=false) => { const path=`test/scratch/browser/shots/${name}.png`; await page.screenshot({path,fullPage}); shots.push(path); };
let sharedContext, alice, bobContext, bob;
try {
 await test('live official API loads in an actual browser without fixtures',async()=>{
  const ctx=await context(390,false),page=await ctx.newPage();
  const responses=[];page.on('response',r=>{if(r.url().startsWith('https://api.squeekchain.com/')) responses.push({endpoint:new URL(r.url()).pathname,status:r.status()});});
  await page.goto(staticURL);try{await page.waitForFunction(()=>/^Confirmed .*round/.test(document.querySelector('#chain-line').textContent),null,{timeout:45000});}catch{throw new Error('Live read did not recover within 45 seconds: '+await page.locator('#chain-freshness').innerText());}
  const observed=await page.locator('#chain-line').innerText();
  assert.match(observed,/round/);assert.doesNotMatch(observed,/9007199254740993/);
  results.push({name:'live API observation',passed:true,observed,responses});
  await screenshot(page,'live-390');await ctx.close();
 });
 await test('static gateway subpath, first screen, navigation and no overflow at 320/390/700/1440',async()=>{
  const ctx=await context(),page=await ctx.newPage();await page.goto(staticURL);await until(page,'#service-note','Device mode');
  await until(page,'#chain-line','Confirmed');assert.match(await page.locator('#chain-line').innerText(),/9,007,199,254,740,993/);
  assert.match(await page.locator('#chain-pending').innerText(),/Provisional.*801/);
  const start=await page.locator('#start-25').boundingBox();assert.ok(start.y+start.height<844);
  for(const width of [320,390,700,1440]) {
   await page.setViewportSize({width,height:844});
   for(const view of ['home','rooms','world','expeditions','board','profile']) {
    await page.locator(`nav [data-view="${view}"]`).click();
    await page.waitForTimeout(40);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${view} overflows ${width}`);
   }
  }
  await page.locator('[data-view="home"]').click();await page.setViewportSize({width:390,height:844});await screenshot(page,'device-home-390');
  await page.locator('[data-view="board"]').click();assert.match(await page.locator('#board-note').innerText(),/shared league needs/);
  await page.locator('[data-view="world"]').click();assert.equal(await page.locator('#world-name').innerText(),'The Growing Village');
  await ctx.close();
 });
 await test('static timer starts, reloads, completes with clock advancement, cancels and downloads',async()=>{
  const ctx=await context(),page=await ctx.newPage();await page.clock.install();await page.goto(staticURL);await until(page,'#service-note','Device mode');
  await page.locator('#start-25').click();await until(page,'#session-note','25 minute');assert.ok(await page.locator('#start-50').isDisabled());
  await page.reload();await until(page,'#session-note','25 minute');assert.ok(await page.locator('#cancel').isVisible());
  await page.clock.fastForward(1501000);await page.locator('[data-view="profile"]').click();await until(page,'#profile-stats','25 XP');
  await page.locator('#device-name').fill('Audited device');await page.locator('#device-profile button').click();await until(page,'#profile-name','Audited device');
  const download=page.waitForEvent('download');await page.locator('#share').click();const file=await download;assert.equal(file.suggestedFilename(),'squeek-hours.png');await file.saveAs('test/scratch/browser/share-card.png');
  await page.locator('[data-view="home"]').click();await page.locator('#start-50').click();await until(page,'#session-note','50 minute');
  page.once('dialog',dialog=>dialog.accept());await page.locator('#cancel').click();await until(page,'#session-note','cancelled');
  await page.locator('[data-view="profile"]').click();assert.match(await page.locator('#profile-stats').innerText(),/25 XP.*25 minutes.*1 sessions/);
  await screenshot(page,'device-profile-390');await ctx.close();
 });
 await test('custom-duration form, keyboard modal close and account scope',async()=>{
  const ctx=await context(),page=await ctx.newPage();await page.goto(staticURL);await until(page,'#service-note','Device mode');
  await page.locator('#auth-open').focus();await page.keyboard.press('Enter');assert.ok(await page.locator('#auth').isVisible());assert.ok(!(await page.locator('input[name="password"]').isVisible()));
  await page.keyboard.press('Escape');assert.ok(!(await page.locator('#auth').isVisible()));assert.equal(await page.evaluate(()=>document.activeElement.id),'auth-open');
  await page.locator('#custom-controls summary').click();await page.locator('#custom-minutes').fill('1');await page.locator('#start-custom').click();await until(page,'#session-note','Custom');
  const active=await page.evaluate(()=>JSON.parse(localStorage.getItem('squeek-hours-device-v1')).active);assert.equal(active.plannedSeconds,60);
  await screenshot(page,'custom-active-390');await ctx.close();
 });
 await test('offline chain ends loading, stale snapshot stays separate, recovery and malformed JSON',async()=>{
  const ctx=await context(),page=await ctx.newPage();await page.clock.install();let outcome='success';
  await ctx.unroute('https://api.squeekchain.com/**');await ctx.route('https://api.squeekchain.com/**',route=>outcome==='offline'?route.abort():outcome==='bad'?route.fulfill({contentType:'text/html',body:'<html>broken</html>'}):route.fulfill({contentType:'application/json',body:JSON.stringify(route.request().url().endsWith('/core')?core():status())}));
  await page.goto(staticURL);await until(page,'#chain-line','Confirmed');outcome='offline';await page.clock.fastForward(9000);await until(page,'#chain-freshness','Stale');assert.match(await page.locator('#chain-line').innerText(),/Last confirmed snapshot/);assert.match(await page.locator('#chain-state').innerText(),/unavailable/);
  outcome='success';await page.clock.fastForward(16000);await until(page,'#chain-line','Confirmed');assert.doesNotMatch(await page.locator('#chain-freshness').innerText(),/Stale/);
  outcome='bad';await page.clock.fastForward(9000);await until(page,'#chain-freshness','Stale');
  await screenshot(page,'stale-chain-390');await ctx.close();
  const empty=await context(),emptyPage=await empty.newPage();await empty.unroute('https://api.squeekchain.com/**');await empty.route('https://api.squeekchain.com/**',r=>r.abort());await emptyPage.goto(staticURL);await until(emptyPage,'#chain-line','unavailable');assert.ok(await emptyPage.locator('#start-25').isEnabled());await empty.close();
 });
 await test('storage failure is visible and does not pretend persistence',async()=>{
  const ctx=await context();await ctx.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new Error('Browser storage blocked');}}));
  const page=await ctx.newPage();await page.goto(staticURL);await until(page,'#page-error','storage blocked');assert.ok(await page.locator('#start-25').isDisabled());await ctx.close();
 });
 await test('server registration, login failure, persistence and account session start',async()=>{
  sharedContext=await context();alice=await sharedContext.newPage();await alice.goto(serverURL);await until(alice,'#service-note','Shared service');
  await alice.locator('#start-25').click();assert.ok(await alice.locator('#auth').isVisible());
  await alice.locator('[name="username"]').fill('browser_alice');await alice.locator('[name="password"]').fill('test-password-123');await alice.locator('#register').click();await until(alice,'#who','browser_alice');
  await alice.locator('#start-25').click();await until(alice,'#session-note','25 minute');await alice.reload();await until(alice,'#session-note','25 minute');
  alice.once('dialog',dialog=>dialog.accept());await alice.locator('#cancel').click();await until(alice,'#session-note','cancelled');
  await alice.locator('#auth-open').click();await until(alice,'#who','Guest');await alice.locator('#auth-open').click();await alice.locator('[name="username"]').fill('browser_alice');await alice.locator('[name="password"]').fill('wrong-password');await alice.locator('#auth-form button[type="submit"]').click();await until(alice,'#auth-error','Wrong username');
  await alice.locator('[name="password"]').fill('test-password-123');await alice.locator('#auth-form button[type="submit"]').click();await until(alice,'#who','browser_alice');
  bobContext=await context();bob=await bobContext.newPage();await bob.goto(serverURL);await until(bob,'#service-note','Shared service');await bob.locator('#auth-open').click();await bob.locator('[name="username"]').fill('browser_bob');await bob.locator('[name="password"]').fill('test-password-123');await bob.locator('#register').click();await until(bob,'#who','browser_bob');
 });
 await test('two real accounts share public/private room presence and messages; private heartbeat survives',async()=>{
  assert.ok(alice&&bob);
  for(const page of [alice,bob]){await page.locator('[data-view="rooms"]').click();await page.getByRole('button',{name:'Join Global Focus',exact:true}).click();}
  await alice.locator('#room-focus').fill('Writing code');await alice.locator('#room-focus').blur();
  await alice.locator('#room-text').fill('Hello from Alice');await alice.locator('#room-form button').click();await until(bob,'#room-log','Hello from Alice');
  assert.match(await bob.locator('#room-people').innerText(),/browser_alice.*Writing code/);
  await alice.locator('#private-name').fill('Audit private room');await alice.locator('#private-goal').fill('Preserve real collaboration');await alice.locator('#private-form button').click();await until(alice,'#private-result','invite:');
  const slug=await alice.locator('#invite-slug').inputValue(),invite=await alice.locator('#invite-code').inputValue();
  const denied=await bob.request.get(serverURL+'api/rooms/'+slug);assert.equal(denied.status(),403);
  await bob.locator('#invite-slug').fill(slug);await bob.locator('#invite-code').fill(invite);await bob.locator('#invite-form button').click();await until(bob,'#room-name','Audit private room');
  await bob.locator('#room-focus').fill('Private focus');await bob.locator('#room-focus').blur();await until(bob,'#room-people','Private focus');
  await bob.locator('#room-text').fill('Private note');await bob.locator('#room-form button').click();await until(bob,'#room-log','Private note');
  const detail=await (await bob.request.get(serverURL+'api/rooms/'+slug)).json();assert.equal('invite' in detail.room,false);
  await alice.locator('#room-focus').fill('Private coding');await alice.locator('#room-focus').blur();await until(alice,'#room-log','Private note');
  const nextHeartbeat=bob.waitForRequest(r=>r.url().endsWith('/api/rooms/'+slug+'/join') && !JSON.parse(r.postData()||'{}').invite,{timeout:7000});await nextHeartbeat;await until(bob,'#room-people','Private focus');assert.equal(await bob.locator('#room-error').innerText(),'');await screenshot(alice,'private-room-390',true);
  await bob.locator('#room-leave').click();await bob.locator('#room-panel').waitFor({state:'hidden'});
 });
 await test('server completion awards exact XP once, updates board, expedition and profile theme',async()=>{
  await alice.locator('#room-start').click();await until(alice,'#session-note','25 minute');await advance(1501);
  await alice.reload();await until(alice,'#who','browser_alice');await alice.locator('[data-view="profile"]').click();await until(alice,'#profile-stats','25 XP');
  await alice.locator('[data-view="board"]').click();await until(alice,'#leaders','browser_alice');assert.match(await alice.locator('#leaders').innerText(),/25 XP/);
  await alice.locator('[data-view="expeditions"]').click();await until(alice,'#expedition','1 / 1000 sessions');assert.match(await alice.locator('#expedition').innerText(),/25 \/ 10000 minutes/);
  await alice.locator('[data-view="home"]').click();await alice.locator('#custom-controls summary').click();await alice.locator('#custom-minutes').fill('100');await alice.locator('#start-custom').click();await until(alice,'#session-note','Custom');await advance(6001);
  await alice.reload();await until(alice,'#who','browser_alice');await alice.locator('[data-view="profile"]').click();await until(alice,'#profile-stats','125 XP');await alice.locator('#themes button').filter({hasText:/^lamp$/}).click();await alice.waitForFunction(()=>document.body.dataset.theme==='lamp');await screenshot(alice,'server-profile-lamp-390');
  await alice.locator('#auth-open').click();await until(alice,'#who','Guest');assert.equal(await alice.locator('#badges li').count(),0);assert.ok(await alice.locator('#share').isDisabled());
 });
 await test('keyboard focus, enlarged text and RTL remain usable',async()=>{
  const ctx=await context(),page=await ctx.newPage();await page.goto(staticURL);await until(page,'#service-note','Device mode');
  await page.keyboard.press('Tab');assert.equal(await page.locator(':focus').innerText(),'Skip to content');await screenshot(page,'keyboard-skip-390');
  await page.addStyleTag({content:'html { font-size: 200%; }'});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await screenshot(page,'text-200-percent-390',true);
  await page.evaluate(()=>document.documentElement.dir='rtl');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await ctx.close();
 });
 await test('WebKit primary interaction if supplied binary is available',async()=>{
  let safari;try{safari=await webkit.launch({headless:true});}catch{return 'skip';}
  try{const ctx=await safari.newContext();await fixtures(ctx);const page=await ctx.newPage();await page.goto(staticURL);await until(page,'#service-note','Device mode');await page.locator('#start-25').click();await until(page,'#session-note','25 minute');}finally{await safari.close();}
 });
 assert.equal(errors.length,0,'Unexpected page errors: '+errors.join('; '));
} finally {
 await browser.close();
 backend.stdin.write('{"quit":true}\n');backend.stdin.end();await once(backend,'exit');
 await new Promise(done=>staticServer.close(done));
 await writeFile('test/scratch/browser/results.json',JSON.stringify({results,errors,shots},null,2));
}
const failures=results.filter(r=>r.passed===false);console.log(`${results.filter(r=>r.passed===true).length} passed, ${failures.length} failed.`);if(failures.length)process.exitCode=1;
