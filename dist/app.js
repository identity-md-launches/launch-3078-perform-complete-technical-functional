import { ChainReader, activity, worldFromCore, API } from './chain.js';
import { DeviceStore } from './device.js';

/** @returns {any} */
const $ = id => document.getElementById(id);
let me = null, active = null, world = null;
let roomSlug = '', currentView = 'home', mode = 'loading', serverOffset = 0;
let refreshing = null, starting = false, roomBusy = false, authReturn = null;
const chainReader = new ChainReader();
let device;

async function api(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(new URL(path.replace(/^\//, ''), document.baseURI), {
      method: options.method || 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: options.body ? { 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('The shared service did not return JSON. Check that the Squeek Hours server is running.');
    const payload = await response.json();
    if (!response.ok) {
      if (response.status === 401 && me) { me = null; active = null; roomSlug = ''; clearPrivateViews(); }
      throw new Error(payload.error || `Request failed (HTTP ${response.status}). Try again.`);
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The shared service timed out. Check your connection and try again.');
    if (error instanceof TypeError) throw new Error('The shared service is unreachable. Check your connection and try again.');
    throw error;
  } finally { clearTimeout(timeout); }
}

async function handle(target, action, control = null) {
  $(target).textContent = '';
  if (control) control.disabled = true;
  try { await action(); }
  catch (error) { $(target).textContent = error.message || 'Unable to complete this action. Try again.'; }
  finally { if (control) control.disabled = false; }
}

function clockText(seconds) {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function show(name, focus = false) {
  if (!['home', 'rooms', 'world', 'expeditions', 'board', 'profile'].includes(name)) name = 'home';
  currentView = name;
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('hidden', view.id !== `view-${name}`));
  document.querySelectorAll('nav button').forEach(button => {
    const on = /** @type {HTMLElement} */ (button).dataset.view === name;
    button.classList.toggle('on', on);
    if (on) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  if (focus) {
    const heading = $(`view-${name}`).querySelector('h1,h2');
    heading.setAttribute('tabindex', '-1'); heading.focus();
  }
  if (name === 'rooms') handle('room-error', loadRooms);
  if (name === 'world') paintWorld();
  if (name === 'expeditions') handle('page-error', loadExpedition);
  if (name === 'board') handle('board-note', loadBoard);
  if (name === 'profile') paintProfile();
}

const formatted = value => BigInt(value).toLocaleString('en-US');
function paintChain() {
  const core = chainReader.slots.core, status = chainReader.slots.status;
  const stale = chainReader.isStale('core');
  const wheel = activity(status.data, Date.now(), chainReader.isStale('status'));
  $('clock').classList.toggle('rest', wheel.state === 'resting');
  $('clock').classList.toggle('down', wheel.state === 'unavailable');
  $('chain-state').textContent = wheel.state === 'resting' ? `Wheel resting · ${wheel.rpm} rpm` : wheel.state === 'active' ? `Wheel active · ${wheel.rpm} rpm` : 'Wheel activity unavailable';
  $('chain-state').classList.toggle('muted', wheel.state === 'unavailable');
  if (core.data) {
    const c = core.data.core;
    $('chain-line').textContent = `${stale ? 'Last confirmed snapshot' : 'Confirmed'} · round ${formatted(c.settledThroughRound)} · ${formatted(c.cumulativeWork)} work · block ${formatted(c.blockHeight)}`;
    $('chain-freshness').textContent = `${stale ? 'Stale · ' : ''}Checked ${new Date(core.checkedAt).toLocaleTimeString()}${core.error ? ` · ${core.error}` : stale ? ' · The confirmed read has not advanced recently.' : ' · Sepolia, 12 confirmations.'}`;
    $('chain-proof').textContent = `Confirmed source: ${API}/v1/core. Safe Ethereum block ${core.data.chain.safeThroughBlock}. Settlement transaction recorded ${new Date(Number(core.data.source.blockTimestamp) * 1000).toLocaleString()}.`;
    $('chain-tx').href = `https://sepolia.etherscan.io/tx/${core.data.source.transactionHash}`;
    $('chain-tx').classList.remove('hidden');
    world = worldFromCore(core.data);
  } else {
    $('chain-line').textContent = 'Confirmed settlement unavailable';
    $('chain-freshness').textContent = core.error || 'Waiting for the official API.';
    $('chain-proof').textContent = `Confirmed source: ${API}/v1/core. Missing data is unknown, never zero.`;
    $('chain-tx').classList.add('hidden');
  }
  const submission = status.data?.settlementQueue?.latestSubmission;
  const pending = !chainReader.isStale('status') && ['preparing', 'submitted', 'retrying'].includes(submission?.lifecycle)
    && typeof submission?.settledThroughRound === 'string' && /^\d+$/.test(submission.settledThroughRound)
    && (!core.data || BigInt(submission.settledThroughRound) > BigInt(core.data.core.settledThroughRound));
  $('chain-pending').textContent = pending ? `Provisional · round ${submission.settledThroughRound} ${submission.lifecycle}; not confirmed.`
    : status.error ? `Activity read failed · ${status.error}`
    : wheel.state === 'unavailable' ? 'No fresh measurement. Missing activity is not a resting wheel.'
    : `Provisional measurement · ${wheel.provenance || 'provenance unavailable'} · ${new Date(wheel.observedAt).toLocaleTimeString()}`;
}

async function refreshChain() {
  await Promise.all(['core', 'status'].map(async name => { await chainReader.read(name); paintChain(); paintWorld(); }));
}

function remaining() {
  if (!active) return 0;
  return Math.max(0, Math.ceil((Date.parse(active.startedAt) + active.plannedSeconds * 1000 - Date.now() - serverOffset) / 1000));
}
function paintSession() {
  const busy = !!active || starting || mode === 'loading';
  ['start-25', 'start-50', 'start-custom'].forEach(id => { $(id).disabled = busy; });
  $('custom-minutes').disabled = busy;
  $('cancel').classList.toggle('hidden', !active);
  $('timer').textContent = active ? clockText(remaining()) : '25:00';
  if (active) $('session-note').textContent = `${active.kind === 'custom' ? 'Custom' : active.kind + ' minute'} session · ${mode === 'device' ? 'saved on this device' : 'saved on the server'}`;
}

async function refreshMe() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const payload = mode === 'server' ? await api('/api/me') : await device.snapshot();
    if (payload.serverNow) serverOffset = Date.parse(payload.serverNow) - Date.now();
    else serverOffset = 0;
    const was = active, previousSessions = me?.stats?.sessions || 0, previousUser = me?.user;
    me = payload.user ? payload : null; active = payload.active || null;
    if (mode === 'server' && previousUser && !me) { roomSlug = ''; clearPrivateViews(); }
    $('who').textContent = mode === 'device' ? 'On this device' : payload.user?.username || 'Guest';
    $('auth-open').textContent = mode === 'device' ? 'About accounts' : payload.user ? 'Sign out' : 'Sign in';
    document.body.dataset.theme = payload.user?.theme || 'burrow';
    paintSession();
    if (was && !active) {
      $('session-note').textContent = (me?.stats?.sessions || 0) > previousSessions
        ? `Session saved · ${mode === 'device' ? 'device profile updated' : 'profile updated'}.`
        : 'Session ended or was cancelled in another tab.';
      refreshToday().catch(error => { $('page-error').textContent = error.message; });
    }
    if (currentView === 'profile') paintProfile();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function refreshToday() {
  if (mode === 'device') {
    const snapshot = await device.snapshot();
    const state = device.load(), today = new Date().toISOString().slice(0, 10);
    $('today').textContent = String(state.sessions.filter(row => row.endedAt.startsWith(today)).reduce((sum, row) => sum + row.plannedSeconds / 60, 0));
    $('today-label').textContent = 'focus minutes on this device today (UTC)';
    $('live-count').textContent = 'Shared room counts need the Squeek Hours server.';
    $('mission-bar').textContent = 'Shared expedition totals unavailable in device mode.';
    return snapshot;
  }
  try {
    const payload = await api('/api/expedition');
    $('today').textContent = String(payload.community.todayMinutes);
    $('today-label').textContent = 'community focus minutes today (UTC)';
    $('live-count').textContent = `${payload.community.activeUsers} people in rooms right now`;
    const mission = payload.mission;
    $('mission-name').textContent = `Mission ${mission.id} · ${mission.name}`;
    $('mission-bar').textContent = `${payload.community.sessions} / ${mission.sessions} sessions · ${payload.community.minutes} / ${mission.minutes} minutes`;
  } catch (error) {
    $('today').textContent = 'Unavailable'; $('live-count').textContent = 'Shared participation could not be loaded.';
    $('mission-bar').textContent = 'Community progress unavailable. Check the shared service.';
    throw error;
  }
}

function openAuth() {
  authReturn = document.activeElement;
  $('auth-title').textContent = mode === 'device' ? 'Accounts need the shared service' : 'Sign in';
  $('auth-help').textContent = mode === 'device' ? 'This static site keeps focus sessions in this browser. Accounts, shared rooms and the league work when this app runs with its Python server. Device sessions are not uploaded or added to shared rankings.' : 'Use your Squeek Hours account. This is separate from a Squeekchain Community account.';
  $('auth-fields').classList.toggle('hidden', mode === 'device');
  $('auth-error').textContent = '';
  $('auth').showModal();
}

async function start(kind, minutes = undefined) {
  if (mode === 'loading' || starting) return;
  if (mode === 'server' && !me?.user) { openAuth(); return; }
  starting = true; paintSession();
  try {
    if (mode === 'device') await device.start(kind, minutes);
    else await api('/api/sessions', { method: 'POST', body: { kind, minutes, room: roomSlug || undefined } });
    await refreshMe();
  } finally { starting = false; paintSession(); }
}

async function loadRooms() {
  if (mode !== 'server') {
    $('rooms-status').textContent = 'Shared rooms need the Squeek Hours server. You can still focus and save a profile on this device.';
    $('room-list').replaceChildren();
    ['private-form', 'invite-form'].forEach(id => { $(id).querySelectorAll('input,button').forEach(control => { control.disabled = true; }); });
    return;
  }
  $('rooms-status').textContent = 'Loading rooms…';
  const payload = await api('/api/rooms');
  $('room-list').replaceChildren();
  payload.rooms.forEach(room => {
    const card = document.createElement('article'), title = document.createElement('h3'), meta = document.createElement('p'), button = document.createElement('button');
    title.textContent = room.name; meta.textContent = `${room.live} here now`;
    button.type = 'button'; button.className = 'ghost'; button.textContent = room.slug === roomSlug ? 'Rejoin' : 'Join room';
    button.setAttribute('aria-label', `Join ${room.name}`);
    button.addEventListener('click', () => handle('room-error', () => enter(room.slug), button));
    card.append(title, meta, button); $('room-list').appendChild(card);
  });
  $('rooms-status').textContent = me ? 'Join a room to share your focus.' : 'Sign in to join a room.';
}

async function enter(slug, invite = undefined) {
  if (mode !== 'server') throw new Error('Shared rooms need the Squeek Hours server.');
  if (!me) { openAuth(); return; }
  await api(`/api/rooms/${encodeURIComponent(slug)}/join`, { method: 'POST', body: { focus: $('room-focus').value, invite } });
  const changed = roomSlug !== slug;
  roomSlug = slug;
  $('room-panel').classList.remove('hidden');
  await paintRoom();
  if (changed) $('room-name').focus();
}
async function paintRoom() {
  if (!roomSlug) return;
  const payload = await api(`/api/rooms/${encodeURIComponent(roomSlug)}`);
  $('room-name').textContent = payload.room.name;
  $('room-goal').textContent = payload.room.goal || 'No shared goal yet.';
  $('room-people').replaceChildren();
  (payload.people.length ? payload.people : [{ username: 'Nobody is in this room yet.', focus: '' }]).forEach(person => {
    const li = document.createElement('li'); li.textContent = person.focus ? `${person.username} · ${person.focus}` : person.username; $('room-people').append(li);
  });
  const fragment = document.createDocumentFragment();
  payload.messages.forEach(note => {
    const li = document.createElement('li'); li.textContent = `${note.username}: ${note.body}`; fragment.append(li);
  });
  if (!payload.messages.length) { const li = document.createElement('li'); li.textContent = 'No notes yet. Share what you are working on.'; fragment.append(li); }
  $('room-log').replaceChildren(fragment);
}
async function heartbeat() {
  if (!roomSlug || roomBusy || document.hidden) return;
  roomBusy = true;
  try { await enter(roomSlug); $('room-error').textContent = ''; }
  catch (error) { $('room-error').textContent = `Room updates paused. ${error.message}`; }
  finally { roomBusy = false; }
}

function paintWorld() {
  if (!world) {
    $('world-name').textContent = 'Confirmed world progress unavailable';
    $('world-copy').textContent = 'A world stage loads after a valid confirmed-state response. Refresh the chain on Home to try again.'; return;
  }
  $('world-name').textContent = world.name;
  $('world-copy').textContent = `${chainReader.isStale('core') ? 'Stale snapshot · ' : ''}Stage ${world.stage} follows confirmed round ${formatted(world.settledRounds)}. Provisional blocks do not unlock a stage.${world.nextRound ? ` Next stage opens at confirmed round ${formatted(world.nextRound)}.` : ' This is the final stage.'}`;
}
async function loadExpedition() {
  const root = $('expedition'); root.replaceChildren();
  const community = document.createElement('article'), heading = document.createElement('h3'), copy = document.createElement('p');
  heading.textContent = 'Community progress'; community.append(heading, copy);
  copy.textContent = mode === 'server' ? 'Loading shared progress…' : 'Shared expedition totals need the Squeek Hours server. Device sessions stay separate.';
  root.append(community);
  const hamster = document.createElement('article'), title = document.createElement('h3'), text = document.createElement('p');
  title.textContent = 'Hamster progress';
  text.textContent = world ? `${world.name} · confirmed round ${formatted(world.settledRounds)}${chainReader.isStale('core') ? ' · stale snapshot' : ''}. This is chain progress, not focus minutes.` : 'Confirmed chain progress unavailable.';
  hamster.append(title, text); root.append(hamster);
  if (mode === 'server') {
    const payload = await api('/api/expedition');
    const c = payload.community, m = payload.mission;
    const done = c.sessions >= m.sessions && c.people >= m.people && c.minutes >= m.minutes && c.consecutiveDays >= m.days;
    copy.textContent = `${done ? 'Mission complete · ' : ''}${c.sessions} / ${m.sessions} sessions · ${c.people} / ${m.people} people · ${c.minutes} / ${m.minutes} minutes · ${c.consecutiveDays} / ${m.days} consecutive active days (UTC).`;
  }
}
async function loadBoard() {
  const list = $('leaders'); list.replaceChildren();
  if (mode !== 'server') { $('board-note').textContent = 'The shared league needs the Squeek Hours server. Device XP is personal and is never submitted as a shared score.'; return; }
  $('board-note').textContent = 'Loading shared rankings…';
  const payload = await api('/api/leaderboard');
  $('board-note').textContent = 'Ranks come from finished sessions on this server. Focus XP is not SQK.';
  if (!payload.leaders.length) { const li = document.createElement('li'); li.textContent = 'No finished sessions yet. Complete a focus session to enter the league.'; list.append(li); }
  payload.leaders.forEach(leader => {
    const li = document.createElement('li'); li.textContent = `${leader.username} · ${leader.level} · ${leader.xp} XP · ${leader.minutes} min · streak ${leader.streak}`; list.append(li);
  });
}
function clearPrivateViews() {
  ['themes', 'badges', 'room-people', 'room-log', 'private-result'].forEach(id => $(id).replaceChildren());
  $('room-panel').classList.add('hidden'); $('share').disabled = true;
  $('device-profile').classList.add('hidden'); $('profile-stats').textContent = ''; $('profile-scope').textContent = '';
  ['room-focus', 'room-text', 'invite-slug', 'invite-code'].forEach(id => { $(id).value = ''; });
  paintProfile();
}
function paintProfile() {
  if (!me?.user) { $('profile-name').textContent = 'Sign in to keep a profile'; $('profile-stats').textContent = 'Use Sign in to save focus sessions to your account.'; $('themes').replaceChildren(); $('badges').replaceChildren(); $('share').disabled = true; return; }
  const stats = me.stats;
  $('profile-name').textContent = me.user.username;
  $('profile-scope').textContent = mode === 'device' ? 'Saved in this browser only. Clearing site data removes this profile. Device XP is not a shared score.' : 'Saved on the Squeek Hours server. Early Bird and Night Owl use UTC.';
  $('device-profile').classList.toggle('hidden', mode !== 'device');
  if (document.activeElement !== $('device-name')) $('device-name').value = me.user.username;
  $('profile-stats').textContent = `${stats.level} · ${stats.xp} XP · ${stats.minutes} minutes · ${stats.sessions} sessions · streak ${stats.streak} · best ${stats.best}`;
  $('share').disabled = false; $('themes').replaceChildren();
  me.themes.forEach(theme => {
    const button = document.createElement('button'); button.type = 'button';
    button.textContent = theme.open ? theme.id : `${theme.id} · ${theme.xp} XP`;
    button.disabled = !theme.open; button.className = 'ghost'; button.setAttribute('aria-pressed', String(me.user.theme === theme.id));
    button.addEventListener('click', () => handle('page-error', async () => {
      if (mode === 'device') await device.profile(undefined, theme.id);
      else await api('/api/theme', { method: 'POST', body: { theme: theme.id } });
      await refreshMe(); paintProfile();
    })); $('themes').append(button);
  });
  $('badges').replaceChildren();
  me.achievements.forEach(badge => {
    const li = document.createElement('li'); li.textContent = `${badge.name} · ${badge.earned ? 'earned' : mode === 'device' && ['Community Builder', 'Expedition Pioneer'].includes(badge.name) ? 'shared service only' : 'not earned yet'}`; $('badges').append(li);
  });
}
function shareCard() {
  if (!me) return;
  const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 675;
  const pen = canvas.getContext('2d');
  pen.fillStyle = '#090d16'; pen.fillRect(0, 0, 1200, 675);
  pen.fillStyle = '#a6ff5b'; pen.font = '64px Georgia'; pen.fillText('SQUEEK HOURS', 64, 140);
  pen.fillStyle = '#f5f7fa'; pen.font = '36px sans-serif';
  pen.fillText(`${me.user.username} · ${me.stats.minutes} focus minutes`, 64, 260);
  pen.fillText(`${me.stats.sessions} sessions · ${me.stats.level} · ${me.stats.xp} XP`, 64, 320);
  pen.fillStyle = '#49d9cf'; pen.font = '28px sans-serif';
  pen.fillText(mode === 'device' ? 'Device profile · personal records, not a shared ranking' : 'Squeek Hours server profile', 64, 450);
  pen.fillText('Focus XP is not SQK.', 64, 510);
  const link = document.createElement('a'); link.href = canvas.toDataURL('image/png'); link.download = 'squeek-hours.png'; link.click();
}

function navigate(name) {
  if (location.hash === `#${name}`) show(name, true);
  else location.hash = name;
}
for (const button of document.querySelectorAll('nav button')) button.addEventListener('click', () => navigate(/** @type {HTMLElement} */ (button).dataset.view));
window.addEventListener('hashchange', () => { if (location.hash !== '#main') show(location.hash.slice(1), true); });
$('start-25').addEventListener('click', () => handle('session-note', () => start('25')));
$('start-50').addEventListener('click', () => handle('session-note', () => start('50')));
$('custom-form').addEventListener('submit', event => { event.preventDefault(); handle('session-note', () => start('custom', Number($('custom-minutes').value))); });
$('cancel').addEventListener('click', () => handle('session-note', async () => {
  if (!active) return;
  if (!confirm('Cancel this session? Unfinished minutes earn no XP.')) return;
  if (mode === 'device') await device.cancel(active.id);
  else await api(`/api/sessions/${active.id}/cancel`, { method: 'POST', body: {} });
  active = null; await refreshMe(); $('session-note').textContent = 'Session cancelled. No XP was added.';
}, $('cancel')));
$('auth-open').addEventListener('click', () => handle('page-error', async () => {
  if (mode === 'server' && me?.user) {
    await api('/api/logout', { method: 'POST', body: {} });
    me = null; active = null; roomSlug = ''; clearPrivateViews();
    await refreshMe(); $('session-note').textContent = 'Signed out. Any running session stays on your account.';
  } else openAuth();
}));
$('auth-close').addEventListener('click', () => $('auth').close());
$('auth').addEventListener('close', () => { $('auth-form').reset(); if (authReturn?.isConnected) authReturn.focus(); });
async function sendAuth(path) {
  const form = $('auth-form');
  if (!form.reportValidity()) return;
  const buttons = form.querySelectorAll('button:not(#auth-close)'); buttons.forEach(button => { button.disabled = true; });
  await handle('auth-error', async () => {
    const data = new FormData(form);
    await api(path, { method: 'POST', body: { username: data.get('username'), password: data.get('password') } });
    $('auth').close(); await refreshMe();
    $('session-note').textContent = active ? $('session-note').textContent : 'Signed in. Choose a session to begin.';
    if (currentView === 'rooms') await loadRooms();
  });
  buttons.forEach(button => { button.disabled = false; });
}
$('auth-form').addEventListener('submit', event => { event.preventDefault(); sendAuth('/api/login'); });
$('register').addEventListener('click', () => sendAuth('/api/register'));
$('room-form').addEventListener('submit', event => { event.preventDefault(); handle('room-error', async () => {
  if (!roomSlug) throw new Error('Join a room first.');
  await api(`/api/rooms/${encodeURIComponent(roomSlug)}/messages`, { method: 'POST', body: { body: $('room-text').value } });
  $('room-text').value = ''; await paintRoom();
}, $('room-form').querySelector('button')); });
$('room-focus').addEventListener('change', () => { if (roomSlug) handle('room-error', () => enter(roomSlug)); });
$('room-leave').addEventListener('click', () => handle('room-error', async () => {
  await api('/api/rooms/leave', { method: 'POST', body: {} }); roomSlug = ''; $('room-panel').classList.add('hidden'); await loadRooms();
}));
$('room-start').addEventListener('click', () => { navigate('home'); handle('session-note', () => start('25')); });
$('private-form').addEventListener('submit', event => { event.preventDefault(); handle('room-error', async () => {
  if (!me) { openAuth(); return; }
  const payload = await api('/api/rooms', { method: 'POST', body: { name: $('private-name').value, goal: $('private-goal').value } });
  $('private-result').textContent = `Room code: ${payload.slug} · invite: ${payload.invite}. Share both privately.`;
  $('invite-slug').value = payload.slug; $('invite-code').value = payload.invite;
  await enter(payload.slug, payload.invite);
}, $('private-form').querySelector('button')); });
$('invite-form').addEventListener('submit', event => { event.preventDefault(); handle('room-error', () => enter($('invite-slug').value.trim(), $('invite-code').value.trim()), $('invite-form').querySelector('button')); });
$('device-profile').addEventListener('submit', event => { event.preventDefault(); handle('page-error', async () => { await device.profile($('device-name').value); await refreshMe(); $('page-error').textContent = 'Display name saved on this device.'; }); });
$('share').addEventListener('click', shareCard);
$('chain-retry').addEventListener('click', () => handle('page-error', refreshChain, $('chain-retry')));
window.addEventListener('storage', () => { if (mode === 'device') handle('page-error', async () => { await refreshMe(); await refreshToday(); }); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && mode !== 'loading') { handle('page-error', refreshMe); refreshChain(); } });

async function init() {
  paintSession();
  const runtime = await api('/runtime.json');
  if (!['server', 'device'].includes(runtime.mode)) throw new Error('Unknown runtime mode. Reload the site or check its runtime.json.');
  mode = runtime.mode;
  if (mode === 'device') device = new DeviceStore();
  $('service-note').textContent = mode === 'device' ? 'Device mode · sessions saved in this browser.' : 'Shared service · accounts, rooms and sessions saved on this server.';
  $('session-note').textContent = mode === 'device' ? 'Choose a session. Device XP stays personal.' : 'Sign in, then choose a session. Leaving the tab keeps your timer running.';
  await refreshMe(); await refreshToday();
  show(location.hash.slice(1) || 'home');
}
show('home');
refreshChain();
handle('page-error', init);
const background = action => action().catch(error => { $('page-error').textContent = error.message; });
setInterval(() => { paintChain(); if (active) { paintSession(); if (!remaining()) background(refreshMe); } }, 1000);
setInterval(() => { if (!document.hidden) refreshChain(); }, 8000);
setInterval(() => { if (!document.hidden && mode !== 'loading') background(async () => { await refreshMe(); await refreshToday(); if (currentView === 'board') await loadBoard(); }); }, 8000);
setInterval(heartbeat, 4000);
