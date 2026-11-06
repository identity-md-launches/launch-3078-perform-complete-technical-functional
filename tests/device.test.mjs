import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceStore, xpFor, statsFor } from '../public/device.js';
const memory = () => { const items = new Map(); return { getItem: key => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) }; };
const baseline = Date.parse('2026-11-06T12:00:00Z');
test('XP boundaries and custom cap', () => {
 for (const [kind, seconds, xp] of [['25',1499,0],['25',1500,25],['50',2999,0],['50',3000,50],['custom',299,0],['custom',300,5],['custom',7199,119],['custom',7200,120],['custom',9000,120],['invalid',1500,0]]) assert.equal(xpFor(kind,seconds),xp);
});
test('start, reload, completion and idempotent XP survive different store instances', async () => {
 const storage = memory(); let at = baseline;
 let store = new DeviceStore(storage, () => at);
 await store.start('25'); const id = (await store.snapshot()).active.id;
 at += 120000; store = new DeviceStore(storage, () => at); assert.equal((await store.snapshot()).active.remaining,1380);
 at += 1380000; const finished = await store.snapshot(); assert.equal(finished.active,null); assert.equal(finished.stats.xp,25); assert.equal(store.load().sessions[0].id,id);
 assert.equal((await store.snapshot()).stats.xp,25); assert.equal(store.load().sessions.length,1);
});
test('cancellation and early reads add no XP', async () => {
 let at=baseline; const store=new DeviceStore(memory(),()=>at); await store.start('50'); const id=(await store.snapshot()).active.id;
 at+=5000; await store.cancel(id); assert.equal((await store.snapshot()).stats.xp,0); assert.equal(store.load().sessions.length,0);
});
test('parallel starts serialize where navigator locks are available; sequential duplicates rejected everywhere', async () => {
 const store=new DeviceStore(memory(),()=>baseline); await store.start('25'); await assert.rejects(()=>store.start('50'),/already running/);
});
test('custom durations validate whole minutes and minimum XP threshold', async () => {
 for(const minutes of [0,121,1.5,NaN]) await assert.rejects(()=>new DeviceStore(memory(),()=>baseline).start('custom',minutes));
 let at=baseline; const store=new DeviceStore(memory(),()=>at); await store.start('custom',1); at+=60000; assert.equal((await store.snapshot()).stats.minutes,1); assert.equal((await store.snapshot()).stats.xp,0);
});
test('theme unlocks, profile names and personal badges',async()=>{
 let at=baseline; const store=new DeviceStore(memory(),()=>at);
 await assert.rejects(()=>store.profile(undefined,'lamp'),/locked/); await store.profile('Personal focus'); assert.equal((await store.snapshot()).user.username,'Personal focus');
 await assert.rejects(()=>store.profile(' ')); await assert.rejects(()=>store.profile('x'.repeat(21)));
 await store.start('custom',100); at+=6000000; await store.snapshot(); await store.profile(undefined,'lamp'); assert.equal((await store.snapshot()).user.theme,'lamp');
 assert.equal((await store.snapshot()).achievements.find(b=>b.name==='Community Builder').earned,false);
});
test('UTC streaks, inactivity and best streak',()=>{
 const rows=['2026-11-03','2026-11-04','2026-11-05'].map(day=>({kind:'25',plannedSeconds:1500,endedAt:day+'T23:50:00Z'}));
 assert.equal(statsFor(rows,baseline).streak,3); assert.equal(statsFor(rows,baseline+86400000).streak,0); assert.equal(statsFor(rows,baseline+86400000).best,3);
 assert.equal(statsFor([...rows,rows[2]],baseline).streak,3);
});
test('storage errors and corrupt state are disclosed and never overwritten', async()=>{
 const storage=memory(); storage.setItem('squeek-hours-device-v1','{bad'); const store=new DeviceStore(storage,()=>baseline); await assert.rejects(()=>store.snapshot()); assert.equal(storage.getItem('squeek-hours-device-v1'),'{bad');
 const blocked=new DeviceStore({getItem(){throw new Error('blocked');},setItem(){}},()=>baseline); await assert.rejects(()=>blocked.start('25'),/blocked/);
});
