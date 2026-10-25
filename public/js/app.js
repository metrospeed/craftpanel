import { api, connect, disconnect } from './api.js';
import { html, mount, icon, $, toastError } from './ui.js';
import { state, onState, refreshServers, loadTypes } from './state.js';
import dashboard from './views/dashboard.js';
import create from './views/create.js';
import server from './views/server.js';
import network from './views/network.js';
import users from './views/users.js';
import settings from './views/settings.js';
import { checkForUpdates } from './update.js';

const app = document.getElementById('app');

const routes = [
  [/^$/, dashboard],
  [/^new$/, create],
  [/^server\/([\w-]+)(?:\/(\w+))?$/, server],
  [/^network$/, network, true],
  [/^users$/, users, true],
  [/^settings$/, settings],
];

let cleanup = null;
let unsubSidebar = null;

// Auth screens -------------------------------------------------------------------

function authScreen({ setup }) {
  mount(
    app,
    html`
      <div class="auth">
        <div class="card">
          <div class="brand"><img src="/favicon.svg" alt="" />CraftPanel</div>
          <form class="card-body stack" autocomplete="on">
            <p class="muted small" style="text-align:center;margin:0">
              ${setup ? 'Welcome! Create the administrator account to get started.' : 'Sign in to manage your servers.'}
            </p>
            <label class="field"><span>Username</span><input type="text" name="username" autocomplete="username" required /></label>
            <label class="field"
              ><span>Password</span
              ><input type="password" name="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 8 : 1}"
            /></label>
            ${setup
              ? html`<label class="field"><span>Confirm password</span><input type="password" name="confirm" autocomplete="new-password" required /></label>`
              : ''}
            <button class="btn primary" type="submit">${setup ? 'Create account' : 'Sign in'}</button>
          </form>
        </div>
      </div>
    `,
  );
  $('form', app).onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (setup && f.get('password') !== f.get('confirm')) return toastError('Passwords do not match');
    try {
      const { user } = await api.post(setup ? '/api/auth/setup' : '/api/auth/login', {
        username: f.get('username'),
        password: f.get('password'),
      });
      state.user = user;
      await startApp();
    } catch (err) {
      toastError(err);
    }
  };
  $('input', app).focus();
}

// Main layout ----------------------------------------------------------------------

function renderSidebar() {
  const side = $('.sidebar', app);
  if (!side) return;
  const route = location.hash.slice(2);
  const link = (href, ic, label) => html`<a href="#/${href}" class="${route === href ? 'active' : ''}">${icon(ic)}${label}</a>`;
  const backends = state.servers.filter((s) => !s.isProxy);
  const proxy = state.servers.find((s) => s.isProxy);
  mount(
    side,
    html`
      <div class="brand"><img src="/favicon.svg" alt="" />CraftPanel<small>v${state.version}</small></div>
      ${state.update?.updateAvailable
        ? html`<a class="update-pill" href="#/settings">${icon('arrowUp')}Update available${state.update.latestVersion && state.update.latestVersion !== state.version ? html` · v${state.update.latestVersion}` : ''}</a>`
        : ''}
      <nav class="nav">
        ${link('', 'dashboard', 'Dashboard')} ${state.user.admin ? link('network', 'network', 'Network') : ''}
        ${state.user.admin ? link('users', 'users', 'Users') : ''} ${link('settings', 'settings', 'Settings')}
      </nav>
      <div class="side-section">
        <span>Servers</span>${state.user.admin ? html`<a href="#/new" title="New server">${icon('plus')}</a>` : ''}
      </div>
      <div class="server-list">
        ${proxy ? serverLink(proxy, route) : ''} ${backends.map((s) => serverLink(s, route))}
        ${!state.servers.length ? html`<div class="faint small" style="padding:6px 10px">No servers yet</div>` : ''}
      </div>
      <div class="side-footer">
        <div class="avatar">${state.user.username[0].toUpperCase()}</div>
        <div class="grow">
          <div style="font-weight:600">${state.user.username}</div>
          <div class="faint small">${state.user.admin ? 'Administrator' : 'User'}</div>
        </div>
        <button class="btn ghost icon" id="logout" title="Sign out">${icon('logout')}</button>
      </div>
    `,
  );
  $('#logout', side).onclick = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    location.reload();
  };
}

function serverLink(s, route) {
  const active = route.startsWith(`server/${s.id}`);
  return html`<a class="server-link ${active ? 'active' : ''}" href="#/server/${s.id}">
    <span class="dot ${s.status}"></span>
    <span class="name">${s.name}</span>
    <span class="tag">${s.isProxy ? 'proxy' : s.type}</span>
  </a>`;
}

function layout() {
  mount(
    app,
    html`
      <div class="layout">
        <aside class="sidebar"></aside>
        <main class="main">
          <div class="mobile-bar">
            <button class="btn ghost icon" id="menu">${icon('menu')}</button>
            <img src="/favicon.svg" width="22" alt="" /> CraftPanel
          </div>
          <div class="page" id="page"></div>
        </main>
      </div>
    `,
  );
  $('#menu', app).onclick = () => $('.sidebar', app).classList.toggle('open');
  unsubSidebar?.();
  unsubSidebar = onState(renderSidebar);
  renderSidebar();
}

let routeToken = 0;

async function route() {
  if (!state.user) return;
  const token = ++routeToken;
  cleanup?.();
  cleanup = null;
  $('.sidebar', app)?.classList.remove('open');
  const path = location.hash.replace(/^#\/?/, '');
  // Each navigation gets a fresh container so late async renders from the
  // previous view land in a detached element instead of over the new page.
  const page = document.createElement('div');
  $('#page', app).replaceChildren(page);
  $('.main', app).scrollTop = 0;
  renderSidebar();
  const match = routes.find(([re]) => re.test(path));
  if (!match || (match[2] && !state.user.admin)) {
    mount(page, html`<div class="empty"><h3>Page not found</h3><a href="#/">Back to dashboard</a></div>`);
    return;
  }
  const params = path.match(match[0]).slice(1);
  try {
    const done = (await match[1](page, ...params)) || null;
    if (token === routeToken) cleanup = done;
    else done?.();
  } catch (err) {
    if (token === routeToken) mount(page, html`<div class="empty"><h3>Something went wrong</h3><p>${err.message}</p></div>`);
  }
}

async function startApp() {
  layout();
  connect();
  await Promise.all([refreshServers(), loadTypes()]);
  if (!location.hash) location.hash = '#/';
  route();
  checkForUpdates();
}

window.addEventListener('hashchange', route);
window.addEventListener('cp:unauthorized', () => {
  if (!state.user) return;
  state.user = null;
  disconnect();
  authScreen({ setup: false });
});

(async function boot() {
  try {
    const s = await api.get('/api/auth/state');
    state.version = s.version;
    if (s.setupRequired) return authScreen({ setup: true });
    if (!s.user) return authScreen({ setup: false });
    state.user = s.user;
    await startApp();
  } catch (err) {
    mount(app, html`<div class="boot">Could not reach the panel: ${err.message}</div>`);
  }
})();
