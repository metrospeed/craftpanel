import { api, on, subscribe } from '../api.js';
import { html, mount, icon, bytes, duration, statusBadge, typeIcon, ansiToHtml, $, $$, toastError, confirmDialog, copyText } from '../ui.js';
import { state, onState, serverById, refreshServers, typeName } from '../state.js';
import filesTab from './files.js';
import contentTab from './content.js';
import backupsTab from './backups.js';
import propertiesTab from './properties.js';
import settingsTab from './server-settings.js';
import { startWithCheck, openDatapackDialog } from '../datapacks.js';

const TABS = [
  ['console', 'terminal', 'Console'],
  ['files', 'folder', 'Files'],
  ['content', 'puzzle', null],
  ['backups', 'archive', 'Backups'],
  ['properties', 'list', 'Properties'],
  ['settings', 'sliders', 'Settings'],
];

export default async function server(page, id, tab = 'console') {
  if (!serverById(id)) await refreshServers();
  let s = serverById(id);
  if (!s) {
    mount(page, html`<div class="empty"><h3>Server not found</h3><a href="#/">Back to dashboard</a></div>`);
    return;
  }
  const tabs = TABS.filter(([t]) => {
    if (t === 'content') return !!s.content;
    if (t === 'properties') return !s.isProxy && s.type !== 'custom';
    return true;
  });
  if (!tabs.find(([t]) => t === tab)) tab = 'console';

  mount(
    page,
    html`
      <div class="page-head" id="server-head"></div>
      <div class="tabs">
        ${tabs.map(
          ([t, ic, label]) =>
            html`<a href="#/server/${id}/${t}" class="${t === tab ? 'active' : ''}">${icon(ic)}${label || (s.content === 'mods' ? 'Mods' : 'Plugins')}</a>`,
        )}
      </div>
      <div id="tab"></div>
    `,
  );

  const head = $('#server-head', page);
  let lastHead = '';
  function renderHead() {
    s = serverById(id);
    if (!s) return;
    const st = s.status;
    const out = String(html`
      ${typeIcon(s.type, 44)}
      <div class="grow" style="min-width:0">
        <div class="row" style="gap:12px"><h1>${s.name}</h1>${statusBadge(st)}</div>
        <div class="sub">${typeName(s.type)} ${s.mcVersion}${s.loaderVersion ? ` · ${s.loaderVersion}` : ''}${s.isProxy ? ' · network proxy' : ''}</div>
      </div>
      <div class="btn-group">
        ${st === 'stopped' || st === 'crashed'
          ? html`<button class="btn primary" data-act="start">${icon('play')}Start</button>`
          : ''}
        ${st === 'running' || st === 'starting'
          ? html`<button class="btn" data-act="restart">${icon('restart')}Restart</button>
              <button class="btn" data-act="stop">${icon('stop')}Stop</button>`
          : ''}
        ${st === 'stopping' || st === 'starting' || st === 'running'
          ? html`<button class="btn danger" data-act="kill" title="Force kill the process">${icon('skull')}Kill</button>`
          : ''}
        ${st === 'installing' ? html`<button class="btn" disabled><span class="spinner"></span>Installing…</button>` : ''}
        ${st === 'install_failed' ? html`<a class="btn" href="#/server/${id}/settings">Reinstall…</a>` : ''}
      </div>
      ${s.restartPending
        ? html`<div class="callout warn row" style="flex-basis:100%">
            <span class="grow">Network settings changed while players were online. Restart this server to ${s.joinedNetwork ? 'join the network' : 'apply them'}; until then the proxy won't send players here.</span>
            <button class="btn sm" data-act="restart">${icon('restart')}Restart now</button>
          </div>`
        : ''}
      ${s.issue?.type === 'datapacks' && (st === 'stopped' || st === 'crashed')
        ? html`<div class="callout warn row" style="flex-basis:100%">
            <span class="grow">The server stopped because the world's datapacks failed to load${s.issue.packs.length ? html` (<b>${s.issue.packs.join(', ')}</b>)` : ''}. They were probably made for a different Minecraft version.</span>
            <button class="btn sm primary" data-act="datapacks">${icon('puzzle')}Fix datapacks</button>
          </div>`
        : ''}
    `);
    if (out === lastHead) return;
    lastHead = out;
    head.innerHTML = out;
    $$('[data-act]', head).forEach((b) => {
      b.onclick = async () => {
        const act = b.dataset.act;
        if (act === 'kill' && !(await confirmDialog({ title: 'Force kill?', message: 'The world will not be saved. Only use this if the server is frozen.', confirm: 'Kill', danger: true }))) return;
        b.disabled = true;
        try {
          if (act === 'start') {
            await startWithCheck(s);
            b.disabled = false;
          } else if (act === 'datapacks') {
            await openDatapackDialog(s);
            b.disabled = false;
          } else {
            await api.post(`/api/servers/${id}/${act}`);
          }
        } catch (err) {
          toastError(err);
          b.disabled = false;
        }
      };
    });
  }
  renderHead();
  const unsubHead = onState(renderHead);

  const tabEl = $('#tab', page);
  const views = { console: consoleTab, files: filesTab, content: contentTab, backups: backupsTab, properties: propertiesTab, settings: settingsTab };
  const tabCleanup = await views[tab](tabEl, s);

  return () => {
    unsubHead();
    tabCleanup?.();
  };
}

// Console tab ------------------------------------------------------------------------

function lineClass(line) {
  if (line.startsWith('[CraftPanel]')) return 'panel-line';
  if (line.startsWith('> ')) return 'cmd-line';
  if (/\b(WARN|WARNING)\b/.test(line)) return 'warn-line';
  if (/\b(ERROR|SEVERE|FATAL)\b|Exception/.test(line)) return 'err-line';
  return '';
}

function renderLine(line) {
  const cls = lineClass(line);
  return `<div${cls ? ` class="${cls}"` : ''}>${ansiToHtml(line) || '&nbsp;'}</div>`;
}

async function consoleTab(el, s) {
  const id = s.id;
  mount(
    el,
    html`
      <div class="grid cols-4" style="margin-bottom:16px" id="stats"></div>
      <div class="console">
        <div class="console-out" id="out"></div>
        <form class="console-in" id="cmd">
          <span>&gt;</span>
          <input type="text" placeholder="Type a command (e.g. op YourName, say hello, list)…" autocomplete="off" spellcheck="false" />
        </form>
      </div>
      <div class="row faint small" style="margin-top:8px">
        <span class="grow">↑/↓ for command history. Commands are sent without the leading slash.</span>
        <label class="check"><input type="checkbox" id="autoscroll" checked /><small>Auto-scroll</small></label>
      </div>
    `,
  );
  const out = $('#out', el);
  const input = $('#cmd input', el);
  const auto = $('#autoscroll', el);
  const history = JSON.parse(sessionStorage.getItem(`cp-hist-${id}`) || '[]');
  let hIdx = history.length;

  const scroll = () => {
    if (auto.checked) out.scrollTop = out.scrollHeight;
  };
  const append = (lines) => {
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    out.insertAdjacentHTML('beforeend', lines.map(renderLine).join(''));
    while (out.childElementCount > 2000) out.firstElementChild.remove();
    if (atBottom || auto.checked) scroll();
  };

  const offHistory = on('history', (m) => {
    if (m.server !== id) return;
    out.innerHTML = '';
    append(m.lines.length ? m.lines : ['[CraftPanel] No console output yet. Start the server to see its log here.']);
  });
  const offLog = on('log', (m) => m.server === id && append([m.line]));
  const unsub = subscribe(id);

  $('#cmd', el).onsubmit = async (e) => {
    e.preventDefault();
    const cmd = input.value.trim();
    if (!cmd) return;
    history.push(cmd);
    if (history.length > 100) history.shift();
    sessionStorage.setItem(`cp-hist-${id}`, JSON.stringify(history));
    hIdx = history.length;
    input.value = '';
    try {
      await api.post(`/api/servers/${id}/command`, { command: cmd });
    } catch (err) {
      toastError(err);
    }
  };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowUp' && hIdx > 0) {
      input.value = history[--hIdx];
      e.preventDefault();
    } else if (e.key === 'ArrowDown') {
      hIdx = Math.min(history.length, hIdx + 1);
      input.value = history[hIdx] || '';
      e.preventDefault();
    }
  };

  const statsEl = $('#stats', el);
  function renderStats() {
    const cur = serverById(id);
    if (!cur) return;
    const mem = cur.stats?.memory;
    const addr = cur.isProxy
      ? `${location.hostname}:${cur.port}`
      : cur.joinedNetwork
        ? null
        : `${location.hostname}:${cur.port}`;
    mount(
      statsEl,
      html`
        <div class="card stat">
          <div class="label">Players</div>
          <div class="value">${cur.players ? cur.players.online : '—'}<small>${cur.players ? ` / ${cur.players.max}` : ''}</small></div>
          <div class="faint small" style="margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${cur.players?.sample?.join(', ') || ''}</div>
        </div>
        <div class="card stat">
          <div class="label">CPU</div>
          <div class="value">${cur.stats ? cur.stats.cpu : '—'}<small>${cur.stats ? '%' : ''}</small></div>
          <div class="faint small" style="margin-top:4px">${cur.startedAt ? `Uptime ${duration(Date.now() - cur.startedAt)}` : 'Not running'}</div>
        </div>
        <div class="card stat">
          <div class="label" title="Resident process memory includes the Java heap and JVM overhead">Process memory</div>
          <div class="value">${mem != null ? bytes(mem) : '—'}</div>
          <div class="faint small" style="margin-top:4px">${bytes(cur.memoryMb * 1048576)} heap limit; JVM overhead is additional</div>
        </div>
        <div class="card stat">
          <div class="label">Address</div>
          ${addr
            ? html`<div class="value mono" style="font-size:15px;margin-top:8px;cursor:pointer" title="Click to copy" data-copy="${addr}">${addr}</div>`
            : html`<div class="value" style="font-size:14px;margin-top:8px">Through the network</div>
                <div class="faint small mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${cur.networkHost || ''}">${cur.networkHost || ''}</div>`}
        </div>
      `,
    );
    const c = $('[data-copy]', statsEl);
    if (c) c.onclick = () => copyText(c.dataset.copy);
  }
  renderStats();
  const unsubStats = onState(renderStats);
  input.focus({ preventScroll: true });

  return () => {
    offHistory();
    offLog();
    unsub();
    unsubStats();
  };
}

