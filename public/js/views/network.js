import { api } from '../api.js';
import { html, mount, icon, statusBadge, typeIcon, $, $$, toast, toastError, confirmDialog, copyText } from '../ui.js';
import { refreshServers, typeName } from '../state.js';

export default async function network(page) {
  let net = null;

  async function load() {
    try {
      net = await api.get('/api/network');
    } catch (err) {
      return toastError(err);
    }
    render();
  }

  function render() {
    if (!net.enabled) return renderIntro();
    const addr = `${net.domain || location.hostname}${net.proxyPort !== 25565 ? ':' + net.proxyPort : ''}`;
        const joined = net.servers.filter((s) => s.joined);
    mount(
      page,
      html`
        <div class="page-head">
          <div class="grow">
            <h1>Network</h1>
            <div class="sub">A Velocity proxy links your servers behind one address. Forwarding, ports and secrets are configured automatically.</div>
          </div>
          <button class="btn danger" id="disable">${icon('power')}Disable network</button>
        </div>

        <div class="connect-box">
          <div class="grow">
            <div class="faint small" style="font-weight:600;text-transform:uppercase;letter-spacing:.06em">Players connect to</div>
            <div class="addr">${addr}</div>
          </div>
          <button class="btn sm" data-copy="${addr}">${icon('copy')}Copy</button>
        </div>

        ${net.warnings.map((w) => html`<div class="callout warn" style="margin-bottom:12px">${w}</div>`)}

        <div class="grid cols-2" style="align-items:start;margin-bottom:16px">
          <div class="card">
            <div class="card-head">
              ${typeIcon('velocity', 30)}
              <h3>Velocity proxy</h3>
              ${net.proxy ? statusBadge(net.proxy.status) : ''}
            </div>
            <div class="card-body stack">
              ${net.proxy
                ? html`
                    <div class="muted small">Velocity ${net.proxy.mcVersion} on port <b>${net.proxy.port}</b> · ${net.proxy.memoryMb} MB RAM</div>
                    <div class="btn-group">
                      ${['stopped', 'crashed'].includes(net.proxy.status)
                        ? html`<button class="btn primary" data-proxy="start">${icon('play')}Start proxy</button>`
                        : net.proxy.status === 'running'
                          ? html`<button class="btn" data-proxy="restart">${icon('restart')}Restart</button><button class="btn" data-proxy="stop">${icon('stop')}Stop</button>`
                          : ''}
                      <a class="btn" href="#/server/${net.proxy.id}/console">${icon('terminal')}Console</a>
                      <a class="btn" href="#/server/${net.proxy.id}/content">${icon('puzzle')}Proxy plugins</a>
                    </div>
                  `
                : html`<div class="muted">The proxy server is missing (it may have been deleted).</div>
                    <div><button class="btn primary" id="recreate">${icon('plus')}Recreate proxy</button></div>`}
              <div class="faint small">${joined.length} server(s) in the network. Players can switch between them with <code>/server &lt;name&gt;</code>.</div>
            </div>
          </div>

          <form class="card card-body stack" id="net-form">
            <h3>Settings</h3>
            <label class="field">
              <span>Domain</span>
              <input type="text" name="domain" value="${net.domain}" placeholder="play.example.com" />
            </label>
            <div class="form-grid">
              <label class="field">
                <span>Lobby / default server</span>
                <select name="lobby">
                  ${joined.map((s) => html`<option value="${s.id}" ${s.id === net.lobby ? 'selected' : ''}>${s.name}</option>`)}
                  ${!joined.length ? html`<option value="">No servers in network</option>` : ''}
                </select>
              </label>
              <label class="field">
                <span>Proxy port</span>
                <input type="number" name="proxyPort" value="${net.proxyPort}" min="1" max="65535" />
              </label>
            </div>
            <label class="field">
              <span>Server list MOTD</span>
              <input type="text" name="motd" value="${net.motd}" />
              <span class="hint">Supports MiniMessage colours, e.g. &lt;gold&gt;My Network</span>
            </label>
            <div class="form-grid">
              <label class="field"><span>Max players shown</span><input type="number" name="maxPlayers" value="${net.maxPlayers}" min="1" /></label>
              <label class="check" style="align-self:end">
                <input type="checkbox" name="forcedHosts" ${net.forcedHosts ? 'checked' : ''} />
                <div><b>Per-server addresses</b><small>survival.${net.domain || 'example.com'} → Survival</small></div>
              </label>
            </div>
            <div class="row"><button class="btn primary" type="submit">Save</button><span class="grow"></span><button class="btn sm ghost" type="button" id="regen">Regenerate forwarding secret</button></div>
          </form>
        </div>

        <div class="card" style="margin-bottom:16px">
          <div class="card-head"><h3>Servers</h3><a class="btn sm" href="#/new">${icon('plus')}New server</a></div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Server</th><th>In network</th><th>Direct address</th><th>Internal port</th><th>Status</th></tr></thead>
              <tbody>
                ${net.servers.map(
                  (s) => html`<tr>
                    <td><div class="row">${typeIcon(s.type, 28)}<div><a href="#/server/${s.id}"><b>${s.name}</b></a><div class="faint small">${typeName(s.type)}${s.id === net.lobby ? ' · lobby' : ''}</div></div></div></td>
                    <td>
                      ${s.capable
                        ? html`<label class="switch"><input type="checkbox" data-join="${s.id}" ${s.network ? 'checked' : ''} /><span></span></label>`
                        : html`<span class="faint small" title="Only Paper, Purpur, Folia, Fabric, Forge and NeoForge can join">Not supported</span>`}
                    </td>
                    <td class="mono small">${s.joined ? (net.forcedHosts && s.hostname ? s.hostname : '—') : `${location.hostname}:${s.port}`}</td>
                    <td class="mono small">${s.port}</td>
                    <td>${statusBadge(s.status)}${s.restartPending ? html` <span class="badge starting" title="Players are online, so it wasn't restarted automatically">Restart needed</span>` : ''}</td>
                  </tr>`,
                )}
                ${!net.servers.length ? html`<tr><td colspan="5" class="faint" style="text-align:center;padding:24px">No servers yet. <a href="#/new">Create one</a>.</td></tr>` : ''}
              </tbody>
            </table>
          </div>
          <div class="faint small" style="padding:10px 18px">Joining or leaving applies the settings immediately. Running servers restart automatically when nobody is online.</div>
        </div>

        <div class="card card-body stack">
          <h3>DNS setup</h3>
          <p class="muted" style="margin:0">At your domain registrar or DNS provider (Cloudflare, Namecheap, …), create these records pointing to this machine's public IP:</p>
          <div class="table-wrap"><table>
            <thead><tr><th>Type</th><th>Name</th><th>Value</th><th>Purpose</th></tr></thead>
            <tbody>
              <tr><td class="mono">A</td><td class="mono">${net.domain || 'play.example.com'}</td><td class="mono">your public IP</td><td class="muted small">Main address (lands in the lobby)</td></tr>
              ${net.forcedHosts ? html`<tr><td class="mono">A</td><td class="mono">*.${net.domain || 'play.example.com'}</td><td class="mono">your public IP</td><td class="muted small">Per-server addresses like ${joined[0]?.hostname || 'survival.' + (net.domain || 'play.example.com')}</td></tr>` : ''}
              ${net.proxyPort !== 25565 ? html`<tr><td class="mono">SRV</td><td class="mono">_minecraft._tcp.${net.domain || 'play.example.com'}</td><td class="mono">0 5 ${net.proxyPort} ${net.domain || 'play.example.com'}</td><td class="muted small">Lets players omit the port</td></tr>` : ''}
            </tbody>
          </table></div>
          <div class="callout info">
            Forward TCP port <b>${net.proxyPort}</b> on your router/firewall to this machine. Backend servers listen on 127.0.0.1 only, so they don't need port forwarding and can't be reached around the proxy.
            If you use Cloudflare, set these records to <b>DNS only</b> (grey cloud), not proxied.
          </div>
        </div>
      `,
    );
    bind();
  }

  function renderIntro() {
    mount(
      page,
      html`
        <div class="page-head"><div class="grow"><h1>Network</h1><div class="sub">Connect all your servers behind one address.</div></div></div>
        <div class="grid cols-2" style="align-items:start">
          <div class="card card-body stack">
            <h2>One domain for every server</h2>
            <p class="muted">CraftPanel runs a <b>Velocity</b> proxy in front of your servers and keeps it configured for you:</p>
            <ul class="muted" style="margin:0;padding-left:20px;line-height:1.9">
              <li>Players join <code>play.yourdomain.com</code> and land in the lobby</li>
              <li>Switch servers in-game with <code>/server survival</code></li>
              <li>Optional direct addresses like <code>survival.play.yourdomain.com</code></li>
              <li>Modern forwarding with a shared secret, skins and UUIDs work properly</li>
              <li>Paper/Purpur/Folia are configured automatically; Fabric, Forge and NeoForge get the required proxy mod installed</li>
              <li>Backends bind to localhost, so nobody can bypass the proxy</li>
            </ul>
          </div>
          <form class="card card-body stack" id="enable-form">
            <h3>Enable the network</h3>
            <label class="field"><span>Domain (optional, can be set later)</span><input type="text" name="domain" value="${net.domain}" placeholder="play.example.com" /></label>
            <label class="field"><span>Public port</span><input type="number" name="proxyPort" value="${net.proxyPort}" /><span class="hint">25565 lets players leave the port off. Servers already using this port must be moved first.</span></label>
            <button class="btn primary" type="submit">${icon('network')}Enable network</button>
            <div class="faint small">This downloads Velocity and creates a "Velocity Proxy" server that starts automatically.</div>
          </form>
        </div>
      `,
    );
    $('#enable-form', page).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      const btn = $('button', f);
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Setting up…';
      try {
        net = await api.post('/api/network/enable', { domain: f.domain.value, proxyPort: Number(f.proxyPort.value) });
        await refreshServers();
        toast('Network enabled. Velocity is installing.');
        render();
      } catch (err) {
        toastError(err);
        btn.disabled = false;
        btn.textContent = 'Enable network';
      }
    };
  }

  function bind() {
    $$('[data-copy]', page).forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
    $('#disable', page).onclick = async () => {
      const ok = await confirmDialog({
        title: 'Disable the network?',
        message: 'The proxy will be stopped. Servers go back to their own ports with online-mode on after their next restart.',
        confirm: 'Disable',
        danger: true,
      });
      if (!ok) return;
      net = await api.post('/api/network/disable').catch(toastError);
      await refreshServers();
      load();
    };
    const recreate = $('#recreate', page);
    if (recreate)
      recreate.onclick = async () => {
        recreate.disabled = true;
        try {
          net = await api.post('/api/network/enable');
          await refreshServers();
          render();
        } catch (err) {
          toastError(err);
          recreate.disabled = false;
        }
      };
    $$('[data-proxy]', page).forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        await api.post(`/api/servers/${net.proxy.id}/${b.dataset.proxy}`).catch(toastError);
      };
    });
    $$('[data-join]', page).forEach((c) => {
      c.onchange = async () => {
        try {
          await api.patch(`/api/servers/${c.dataset.join}`, { network: c.checked });
          toast(c.checked ? 'Added to the network. Settings applied; an empty running server restarts automatically.' : 'Removed from the network. Settings applied; an empty running server restarts automatically.');
        } catch (err) {
          toastError(err);
        }
        load();
      };
    });
    const f = $('#net-form', page);
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        net = await api.put('/api/network', {
          domain: f.domain.value,
          lobby: f.lobby.value || null,
          proxyPort: Number(f.proxyPort.value),
          motd: f.motd.value,
          maxPlayers: Number(f.maxPlayers.value),
          forcedHosts: f.forcedHosts.checked,
        });
        toast('Network settings saved and applied to the proxy');
        render();
      } catch (err) {
        toastError(err);
      }
    };
    $('#regen', page).onclick = async () => {
      const ok = await confirmDialog({ title: 'Regenerate secret?', message: 'All network servers must be restarted afterwards so they pick up the new secret.', confirm: 'Regenerate' });
      if (!ok) return;
      net = await api.put('/api/network', { regenerateSecret: true }).catch(toastError);
      toast('Secret regenerated. Restart your servers.');
      render();
    };
  }

  await load();
  // Keep status badges fresh, but don't re-render while the user is typing in the form.
  const timer = setInterval(() => {
    const active = document.activeElement;
    if (!active || !page.contains(active) || active.tagName === 'BUTTON') load();
  }, 5000);
  return () => clearInterval(timer);
}
