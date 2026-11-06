import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChainReader, activity, validateCore, validateStatus, worldFromCore, retryDelay } from '../public/chain.js';
const now = Date.parse('2026-11-06T12:00:00Z');
const core = () => ({ schemaVersion: 1, installationId: 'test-only', status: 'available', chain: { chainId: '11155111', safeThroughBlock: '120' }, core: { settledThroughRound: '800', cumulativeWork: '9007199254740993', blockHeight: '9', blockProgress: '0' }, source: { transactionHash: '0x' + 'ab'.repeat(32), blockNumber: '100', blockTimestamp: '1793966400' } });
const status = () => ({ schemaVersion: 1, installationId: 'test-only', generatedAt: new Date(now).toISOString(), builder: { status: 'unavailable', reason: 'no_measurement' }, settlementQueue: { status: 'unavailable', reason: 'oracle_head_unavailable' }, measurement: { freshness: 'online', observedAt: new Date(now).toISOString(), staleAfterSeconds: 120, coreStatus: 'IDLE', rpmMilli: 0 } });
const response = (data, code = 200, headers = {}) => new Response(code === 304 ? null : JSON.stringify(data), { status: code, headers });

test('confirmed state remains available with no pipeline or measurement', () => {
 assert.equal(validateCore(core()).core.cumulativeWork, '9007199254740993');
 assert.equal(activity(null, now).state, 'unavailable');
 assert.equal(worldFromCore(core()).stage, 2);
});
test('round zero is a real confirmed state and stages use exact large integers', () => {
 const p = core(); p.core.settledThroughRound = '0'; assert.equal(validateCore(p).core.settledThroughRound, '0'); assert.equal(worldFromCore(p).stage, 1);
 for (const [round, stage] of [['799', 1], ['800', 2], ['2000', 3], ['5000', 4], ['10000', 5], ['9007199254740993', 5]]) { p.core.settledThroughRound = round; assert.equal(worldFromCore(p).stage, stage); }
});
test('reject unavailable/unknown schemas, wrong network, numbers, unsafe source and malformed fields', () => {
 assert.throws(() => validateCore({ schemaVersion: 1, status: 'unavailable', reason: 'not_yet_safe' }), /not_yet_safe/);
 for (const mutate of [p => p.schemaVersion = 2, p => p.chain.chainId = '1', p => p.core.cumulativeWork = 1, p => p.core.blockProgress = '1000000000', p => p.source.blockNumber = '121', p => p.source.transactionHash = 'fake', p => p.core.settledThroughRound = '-1']) { const p = core(); mutate(p); assert.throws(() => validateCore(p)); }
});
test('measurement freshness expires independently, including future, fault and failed reads', () => {
 const p = status(); assert.equal(validateStatus(p), p); assert.equal(activity(p, now).state, 'resting');
 assert.equal(activity(p, now + 120000).state, 'unavailable'); assert.equal(activity(p, now - 6000).state, 'unavailable'); assert.equal(activity(p, now, true).state, 'unavailable');
 p.measurement.coreStatus = 'ACTIVE'; p.measurement.rpmMilli = 12500; assert.equal(activity(p, now).rpm, 12.5);
 p.measurement.coreStatus = 'COUNTER_FAULT'; assert.equal(activity(p, now).state, 'unavailable');
 p.measurement = null; assert.equal(validateStatus(p), p); assert.equal(activity(p, now).state, 'unavailable');
});
test('reject malformed telemetry without making an idle wheel', () => {
 const p = status(); p.measurement.rpmMilli = -1; assert.throws(() => validateStatus(p));
 p.measurement = undefined; assert.throws(() => validateStatus(p));
});
test('ETag validation, 304 preserves data and refreshes the read timestamp', async () => {
 let at = now, calls = 0;
 const reader = new ChainReader(async (url, init) => {
  calls++; assert.equal(init.credentials, 'omit');
  if (calls === 1) return response(core(), 200, { ETag: '"exact-etag"' });
  assert.equal(init.headers['If-None-Match'], '"exact-etag"'); return response(null, 304);
 }, () => at);
 await reader.read('core'); const saved = reader.slots.core.data;
 at += 9000; await reader.read('core');
 assert.equal(reader.slots.core.data, saved); assert.equal(reader.slots.core.checkedAt, at); assert.equal(reader.isStale('core'), false);
 at += 301000; assert.equal(reader.isStale('core'), true);
});
test('304 with no cached body is an error', async () => {
 const reader = new ChainReader(async () => response(null, 304), () => now);
 await reader.read('core'); assert.equal(reader.slots.core.data, null); assert.match(reader.slots.core.error, /without a saved/);
});
test('HTTP 200 unavailable retains last good as stale and honors read backoff', async () => {
 let at = now, calls = 0;
 const reader = new ChainReader(async () => ++calls === 1 ? response(core()) : response({ schemaVersion: 1, status: 'unavailable', reason: 'indexer_unavailable' }), () => at);
 await reader.read('core'); at += 9000; await reader.read('core');
 assert.equal(reader.slots.core.data.core.settledThroughRound, '800'); assert.equal(reader.isStale('core'), true); assert.match(reader.slots.core.error, /indexer_unavailable/);
 await reader.read('core'); assert.equal(calls, 2);
});
test('429 and 503 respect Retry-After and recovery clears the warning', async () => {
 for (const code of [429, 503]) {
  let at = now, calls = 0;
  const reader = new ChainReader(async () => ++calls === 1 ? response({}, code, { 'Retry-After': '60' }) : response(core()), () => at);
  await reader.read('core'); at += 59000; await reader.read('core'); assert.equal(calls, 1);
  at += 1001; await reader.read('core'); assert.equal(calls, 2); assert.equal(reader.slots.core.error, '');
 }
});
test('retry dates and malformed retry headers are bounded sensibly', () => {
 assert.equal(retryDelay('2', now), 2000); assert.equal(retryDelay('invalid', now), 15000); assert.equal(retryDelay('Fri, 06 Nov 2026 12:01:00 GMT', now), 60000);
});
test('offline, HTML and malformed JSON never create a confirmed snapshot', async () => {
 for (const fetcher of [async () => { throw new TypeError('offline'); }, async () => new Response('<html>error</html>'), async () => response({})]) {
  const reader = new ChainReader(fetcher, () => now); await reader.read('core'); assert.equal(reader.slots.core.data, null); assert.ok(reader.slots.core.error);
 }
});
test('concurrent polling deduplicates requests and status failure never blocks core', async () => {
 let calls = 0;
 const reader = new ChainReader(async url => { calls++; if (url.endsWith('status')) throw new Error('unreachable'); return response(core()); }, () => now);
 await Promise.all([reader.read('core'), reader.read('core'), reader.read('status')]);
 assert.equal(calls, 2); assert.ok(reader.slots.core.data); assert.equal(reader.isStale('core'), false);
});
test('an eight-second timeout exits loading and reports the failure without a snapshot', async t => {
 t.mock.timers.enable({ apis: ['setTimeout'] });
 const reader = new ChainReader(async (url, init) => new Promise((resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')));
 }), () => now);
 const pending = reader.read('core'); t.mock.timers.tick(8001); await pending;
 assert.equal(reader.slots.core.data, null); assert.match(reader.slots.core.error, /timed out/);
 t.mock.timers.reset();
});
