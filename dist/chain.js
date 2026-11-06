/** Public, read-only Squeekchain data. Never use measurements as settlement. */
export const API = 'https://api.squeekchain.com';
export const CHAIN_ID = '11155111';
/** @type {Array<[bigint, string]>} */
export const STAGES = [[0n, 'The First Burrow'], [800n, 'The Growing Village'], [2000n, 'The Hamster City'], [5000n, 'The Crystal Kingdom'], [10000n, 'The Infinite World']];
const uint = value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export function validateCore(p) {
  if (!p || p.schemaVersion !== 1) throw new Error('Unsupported confirmed-state schema.');
  if (p.status === 'unavailable') throw new Error(`Confirmed state unavailable: ${p.reason || 'unknown reason'}.`);
  if (p.status !== 'available' || p.chain?.chainId !== CHAIN_ID || !uint(p.chain.safeThroughBlock)
    || !p.core || !['settledThroughRound', 'cumulativeWork', 'blockHeight', 'blockProgress'].every(key => uint(p.core[key]))
    || BigInt(p.core.blockProgress) >= 1000000000n || !hash(p.source?.transactionHash)
    || !uint(p.source?.blockNumber) || !uint(p.source?.blockTimestamp)
    || BigInt(p.source.blockNumber) > BigInt(p.chain.safeThroughBlock)) {
    throw new Error('Invalid confirmed-state response or unexpected network.');
  }
  return p;
}

export function validateStatus(p) {
  if (!p || p.schemaVersion !== 1 || typeof p.installationId !== 'string' || !date(p.generatedAt)
    || !['available', 'unavailable'].includes(p.builder?.status)) throw new Error('Unsupported activity response.');
  const m = p.measurement;
  if (m !== null && (!m || !date(m.observedAt) || !['online', 'stale'].includes(m.freshness)
    || !['ACTIVE', 'IDLE', 'COUNTER_FAULT'].includes(m.coreStatus) || m.staleAfterSeconds !== 120
    || !Number.isSafeInteger(m.rpmMilli) || m.rpmMilli < 0)) throw new Error('Invalid activity measurement.');
  if (!['available', 'unavailable'].includes(p.settlementQueue?.status)
    || (p.settlementQueue.latestSubmission != null && (typeof p.settlementQueue.latestSubmission !== 'object' || Array.isArray(p.settlementQueue.latestSubmission)))) throw new Error('Invalid settlement queue.');
  return p;
}

export function activity(p, at = Date.now(), failed = false) {
  const m = p?.measurement;
  const age = m ? at - Date.parse(m.observedAt) : Infinity;
  const fresh = !failed && m?.freshness === 'online' && age >= -5000 && age < m.staleAfterSeconds * 1000;
  return {
    state: !fresh || m.coreStatus === 'COUNTER_FAULT' ? 'unavailable' : m.coreStatus === 'IDLE' ? 'resting' : 'active',
    observedAt: m?.observedAt || null,
    rpm: fresh && m.coreStatus !== 'COUNTER_FAULT' ? m.rpmMilli / 1000 : null,
    provenance: m?.provenance || null,
  };
}

export function worldFromCore(p) {
  if (!p) return null;
  const round = BigInt(p.core.settledThroughRound);
  let index = 0;
  STAGES.forEach(([floor], i) => { if (round >= floor) index = i; });
  return { stage: index + 1, name: STAGES[index][1], settledRounds: p.core.settledThroughRound, nextRound: STAGES[index + 1]?.[0].toString() || null };
}

export function retryDelay(value, at = Date.now()) {
  if (!value) return 15000;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(1000, parsed - at) : 15000;
}

/** Retains only schema-valid last-good responses, with explicit failure and freshness metadata. */
export class ChainReader {
  constructor(fetcher = globalThis.fetch.bind(globalThis), now = Date.now) {
    this.fetcher = fetcher;
    this.now = now;
    this.slots = {
      core: { data: null, error: '', etag: '', checkedAt: 0, nextAt: 0, advancedAt: 0, inFlight: null },
      status: { data: null, error: '', etag: '', checkedAt: 0, nextAt: 0, advancedAt: 0, inFlight: null },
    };
  }
  async read(name) {
    const slot = this.slots[name];
    if (slot.inFlight) return slot.inFlight;
    if (this.now() < slot.nextAt) return slot;
    slot.inFlight = this.request(name, slot).finally(() => { slot.inFlight = null; });
    return slot.inFlight;
  }
  async request(name, slot) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await this.fetcher(`${API}/v1/${name}`, {
        credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: slot.etag ? { Accept: 'application/json', 'If-None-Match': slot.etag } : { Accept: 'application/json' },
      });
      if (response.status === 429 || response.status === 503) {
        slot.nextAt = this.now() + retryDelay(response.headers.get('Retry-After'), this.now());
        throw new Error(`API HTTP ${response.status}. Retrying after the requested delay.`);
      }
      if (response.status === 304) {
        if (!slot.data) throw new Error('API returned 304 without a saved response.');
      } else {
        if (!response.ok) throw new Error(`API HTTP ${response.status}.`);
        const data = await response.json();
        (name === 'core' ? validateCore : validateStatus)(data);
        if (!slot.data || (name === 'core' && slot.data.chain.safeThroughBlock !== data.chain.safeThroughBlock)) slot.advancedAt = this.now();
        slot.data = data;
        slot.etag = response.headers.get('ETag') || '';
      }
      slot.checkedAt = this.now();
      slot.error = '';
      slot.nextAt = this.now() + 8000;
    } catch (error) {
      slot.error = error.name === 'AbortError' ? 'API request timed out. Check your connection.' : error instanceof TypeError ? 'API could not be reached. Check your connection and retry.' : error.message || 'API could not be reached.';
      slot.nextAt = Math.max(slot.nextAt, this.now() + 15000);
    } finally { clearTimeout(timeout); }
    return slot;
  }
  isStale(name) {
    const slot = this.slots[name];
    return !!slot.error || !slot.checkedAt || this.now() - slot.checkedAt > 45000
      || (name === 'core' && this.now() - slot.advancedAt > 300000);
  }
}
