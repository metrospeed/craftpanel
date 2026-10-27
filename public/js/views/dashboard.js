import { api } from '../api.js';
import { html, mount, icon, bytes, statusBadge, typeIcon, $, $$, toastError, copyText, duration } from '../ui.js';
import { state, onState, typeName } from '../state.js';
import { startWithCheck } from '../datapacks.js';

export default async function dashboard(page) {
  let system = null;
  let net = null;

  const load = async () => {
    [system, net] = await Promise.all([
      api.get('/api/system').catch(() => null),
      state.user.admin ? api.get('/api/network').catch(() => null) : null,
    ]);
    render();
  };

  function render() {
    const list = state.servers;
    const running = list.filter((s) => s.status === 'running');
    const players = list.filter((s) => !s.isProxy).reduce((n, s) => n + (s.players?.online || 0), 0);
    const proxy = list.find((s) => s.isProxy);
    const proxyPlayers = proxy?.players?.online;
    const allocated = running.reduce((n, s) => n + s.memoryMb * 1048576, 0);
    const sys = system?.system;
    const memAvailable = sys ? sys.availableMem ?? sys.freeMem : 0;
    const memUsed = sys ? sys.totalMem - memAvailable : 0;
    const memPct = sys ? Math.round((memUsed / sys.totalMem) * 100) : 0;
    const loadPct = sys ? Math.round((sys.load[0] / sys.cores) * 100) : 0;
    const host = location.hostname;

    mount(
      page,
      html`
        <div class="page-head">
          <div class="grow">
            <h1>Dashboard</h1>
            <div class="sub">${sys ? html`${sys.hostname} · ${sys.platform}` : ''}</div>
          </div>
          ${state.user.admin ? html`<a class="btn primary" href="#/new">${icon('plus')}New server</a>` : ''}
        </div>

        ${net?.enabled
          ? html`<div class="connect-box">
              <div class="grow">
                <div class="faint small" style="font-weight:600;text-transform:uppercase;letter-spacing:.06em">Players connect to</div>
                <div class="addr">${net.domain || host}${net.proxyPort !== 25565 ? ':' + net.proxyPort : ''}</div>
              </div>
              ${net.proxy ? statusBadge(net.proxy.status) : ''}
              <button class="btn sm" data-copy="${net.domain || host}${net.proxyPort !== 25565 ? ':' + net.proxyPort : ''}">${icon('copy')}Copy</button>
              <a class="btn sm" href="#/network">${icon('network')}Network</a>
            </div>`
          : state.user.admin && list.filter((s) => !s.isProxy).length > 1
            ? html`<div class="callout info" style="margin-bottom:20px">
                ${icon('network')} Running more than one server? <a href="#/network">Set up the Velocity network</a> so players can reach all of them
                through a single address.
              </div>`
            : ''}

        <div class="grid cols-4" style="margin-bottom:22px">
          <div class="card stat">
            <div class="label">Servers online</div>
            <div class="value">${running.length}<small> / ${list.length}</small></div>
          </div>
          <div class="card stat">
            <div class="label">Players</div>
            <div class="value">${proxyPlayers ?? players}</div>
          </div>
          <div class="card stat">
            <div class="label" title="Memory in use, excluding reclaimable caches when available">Host memory</div>
            <div class="value">${sys ? bytes(memUsed) : '—'}<small> / ${sys ? bytes(sys.totalMem) : '—'}</small></div>
            <div class="meter ${memPct > 90 ? 'bad' : memPct > 75 ? 'warn' : ''}"><div style="width:${memPct}%"></div></div>
            <div class="faint small" style="margin-top:6px">${bytes(memAvailable)} available · ${bytes(allocated)} server heap limits</div>
          </div>
          <div class="card stat">
            <div class="label">CPU load</div>
            <div class="value">${sys ? sys.load[0].toFixed(2) : '—'}<small> on ${sys?.cores || '?'} cores</small></div>
            <div class="meter ${loadPct > 90 ? 'bad' : loadPct > 70 ? 'warn' : ''}"><div style="width:${Math.min(100, loadPct)}%"></div></div>
          </div>
        </div>

        ${list.length
          ? html`<div class="server-cards">${[...list].sort((a, b) => Number(b.isProxy) - Number(a.isProxy)).map(card)}</div>`
          : html`<div class="card empty">
              ${icon('box')}
              <h3>No servers yet</h3>
              <p>Create your first Minecraft server: Paper, Fabric, Forge and more are one click away.</p>
              ${state.user.admin ? html`<a class="btn primary" href="#/new">${icon('plus')}Create a server</a>` : ''}
            </div>`}
      `,
    );

    $$('[data-copy]', page).forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
    $$('.server-card', page).forEach((el) => {
      el.onclick = (e) => {
        if (e.target.closest('button')) return;
        location.hash = `#/server/${el.dataset.id}`;
      };
    });
    $$('[data-action]', page).forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          if (b.dataset.action === 'start') await startWithCheck(state.servers.find((s) => s.id === b.dataset.id));
          else await api.post(`/api/servers/${b.dataset.id}/${b.dataset.action}`);
        } catch (err) {
          toastError(err);
        }
        b.disabled = false;
      };
    });
  }

  function card(s) {
    return html`
      <div class="card server-card" data-id="${s.id}">
        <div class="title">
          ${typeIcon(s.type)}
          <div class="grow" style="min-width:0">
            <h3>${s.name}</h3>
            <div class="faint small">${typeName(s.type)} ${s.mcVersion}${s.isProxy ? ' · proxy' : ''}</div>
          </div>
          ${statusBadge(s.status)}
        </div>
        <div class="meta">
          <span>Players <b>${s.players ? `${s.players.online}/${s.players.max}` : '—'}</b></span>
          <span>CPU <b>${s.stats ? s.stats.cpu + '%' : '—'}</b></span>
          <span title="Resident process memory includes the Java heap and JVM overhead">RAM <b>${s.stats ? bytes(s.stats.memory) : '—'}</b></span>
          <span title="Maximum Java heap; total process memory can be higher">Heap limit <b>${bytes(s.memoryMb * 1048576)}</b></span>
          ${s.startedAt ? html`<span>Up <b>${duration(Date.now() - s.startedAt)}</b></span>` : ''}
        </div>
        <div class="row">
          <span class="faint small grow mono">${s.joinedNetwork ? s.networkHost || 'via network' : `port ${s.port}`}</span>
          ${s.status === 'stopped' || s.status === 'crashed'
            ? html`<button class="btn sm primary" data-action="start" data-id="${s.id}">${icon('play')}Start</button>`
            : s.status === 'running' || s.status === 'starting'
              ? html`<button class="btn sm" data-action="stop" data-id="${s.id}">${icon('stop')}Stop</button>`
              : ''}
        </div>
      </div>
    `;
  }

  render();
  await load();
  const unsub = onState(render);
  const timer = setInterval(load, 15000);
  return () => {
    unsub();
    clearInterval(timer);
  };
}
