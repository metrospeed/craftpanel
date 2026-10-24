import { api, on } from './api.js';

// Shared client state. Views read from here and listen for 'update'.
export const state = {
  user: null,
  version: '',
  servers: [],
  types: [],
};

const subs = new Set();
export function onState(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
export function notify() {
  subs.forEach((fn) => fn(state));
}

export async function refreshServers() {
  state.servers = await api.get('/api/servers');
  notify();
  return state.servers;
}

export async function loadTypes() {
  if (!state.types.length) state.types = await api.get('/api/types');
  return state.types;
}

export const serverById = (id) => state.servers.find((s) => s.id === id);
export const typeName = (t) => state.types.find((x) => x.id === t)?.name || t;

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshServers().catch(() => {}), 150);
}

on('changed', scheduleRefresh);
on('connected', scheduleRefresh);
on('status', ({ server, status }) => {
  const s = serverById(server);
  if (!s) return scheduleRefresh();
  s.status = status;
  if (status !== 'running' && status !== 'starting' && status !== 'stopping') {
    s.stats = null;
    s.players = null;
    s.startedAt = null;
  }
  if (status === 'stopped') scheduleRefresh();
  notify();
});
on('stats', ({ data }) => {
  for (const s of state.servers) {
    const d = data[s.id];
    if (d) Object.assign(s, d);
  }
  notify();
});
