/** Device records are personal timers, never authentication or shared leaderboard evidence. */
const KEY = 'squeek-hours-device-v1';
export const THEMES = [['burrow', 0], ['lamp', 100], ['studio', 300], ['crystal', 800]];
export function xpFor(kind, seconds) {
  if (kind === '25' && seconds >= 1500) return 25;
  if (kind === '50' && seconds >= 3000) return 50;
  if (kind === 'custom' && seconds >= 300) return Math.max(5, Math.min(120, Math.floor(seconds / 60)));
  return 0;
}
export function statsFor(rows, at = Date.now()) {
  const days = [...new Set(rows.map(row => row.endedAt.slice(0, 10)))].sort();
  let streak = 0, best = 0, previous = 0;
  for (const day of days) {
    const stamp = Date.parse(day);
    streak = stamp - previous === 86400000 ? streak + 1 : 1;
    best = Math.max(best, streak); previous = stamp;
  }
  const today = Date.parse(new Date(at).toISOString().slice(0, 10));
  if (!days.length || previous < today - 86400000) streak = 0;
  const xp = rows.reduce((sum, row) => sum + xpFor(row.kind, row.plannedSeconds), 0);
  let level = 'Bronze';
  [['Silver', 100], ['Gold', 300], ['Diamond', 800], ['Legendary', 2000]].forEach(([name, floor]) => { if (xp >= Number(floor)) level = String(name); });
  return { xp, level, minutes: rows.reduce((sum, row) => sum + Math.floor(row.plannedSeconds / 60), 0), sessions: rows.length, streak, best, days: days.length };
}
export class DeviceStore {
  constructor(storage = globalThis.localStorage, now = Date.now) { this.storage = storage; this.now = now; }
  load() {
    const raw = this.storage.getItem(KEY);
    if (!raw) return { version: 1, name: 'Device profile', theme: 'burrow', sessions: [], active: null };
    const state = JSON.parse(raw);
    if (state.version !== 1 || !Array.isArray(state.sessions) || typeof state.name !== 'string'
      || !THEMES.some(([id]) => id === state.theme)
      || !state.sessions.every(row => this.validSession(row) && Number.isFinite(Date.parse(row.endedAt)))
      || (state.active && !this.validSession(state.active))) throw new Error('Device records could not be read. Restore browser storage or use server mode.');
    return state;
  }
  validSession(row) {
    return row && typeof row.id === 'string' && ['25', '50', 'custom'].includes(row.kind)
      && Number.isInteger(row.plannedSeconds) && row.plannedSeconds >= 60 && row.plannedSeconds <= 7200
      && Number.isFinite(Date.parse(row.startedAt));
  }
  save(state) { this.storage.setItem(KEY, JSON.stringify(state)); return state; }
  async change(action) {
    const run = () => {
      const state = this.load();
      if (state.active) {
        const end = Date.parse(state.active.startedAt) + state.active.plannedSeconds * 1000;
        if (this.now() >= end) {
          state.sessions.push({ ...state.active, endedAt: new Date(end).toISOString() });
          state.active = null;
        }
      }
      action(state);
      return this.save(state);
    };
    return globalThis.navigator?.locks ? navigator.locks.request(KEY, run) : run();
  }
  async start(kind, minutes) {
    return this.change(state => {
      if (state.active) throw new Error('A session is already running on this device.');
      const plannedSeconds = kind === '25' ? 1500 : kind === '50' ? 3000 : kind === 'custom' && Number.isInteger(minutes) && minutes >= 1 && minutes <= 120 ? minutes * 60 : 0;
      if (!plannedSeconds) throw new Error('Choose a duration from 1 to 120 minutes.');
      state.active = { id: crypto.randomUUID(), kind, plannedSeconds, startedAt: new Date(this.now()).toISOString() };
    });
  }
  async cancel(id) { return this.change(state => { if (state.active?.id === id) state.active = null; }); }
  async profile(name, theme) {
    return this.change(state => {
      if (name !== undefined) {
        if (!name.trim() || name.trim().length > 20) throw new Error('Use a profile name of 1–20 characters.');
        state.name = name.trim();
      }
      if (theme !== undefined) {
        const need = THEMES.find(([id]) => id === theme)?.[1];
        if (need === undefined || statsFor(state.sessions, this.now()).xp < Number(need)) throw new Error('That theme is still locked.');
        state.theme = theme;
      }
    });
  }
  async snapshot() {
    const state = await this.change(() => {}), stats = statsFor(state.sessions, this.now());
    const early = state.sessions.some(row => new Date(row.startedAt).getUTCHours() < 8);
    const night = state.sessions.some(row => new Date(row.startedAt).getUTCHours() >= 22);
    return { user: { id: 'device', username: state.name, theme: state.theme }, stats,
      active: state.active ? { ...state.active, remaining: Math.max(0, Math.ceil((Date.parse(state.active.startedAt) + state.active.plannedSeconds * 1000 - this.now()) / 1000)) } : null,
      themes: THEMES.map(([id, xp]) => ({ id, xp, open: stats.xp >= Number(xp) })),
      achievements: Object.entries({ 'Early Bird (UTC)': early, 'Night Owl (UTC)': night, '100 Sessions': stats.sessions >= 100, 'Focus Master': stats.minutes >= 1000, 'Expedition Pioneer': false, 'Community Builder': false }).map(([name, earned]) => ({ name, earned })),
    };
  }
}
