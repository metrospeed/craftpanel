import { api } from '../api.js';
import { html, mount, icon, $, toast, toastError, confirmDialog, modal } from '../ui.js';
import { state, serverById, refreshServers, typeName } from '../state.js';

export default async function settingsTab(el, s) {
  const admin = state.user.admin;
  s = serverById(s.id) || s;
  const net = admin ? await api.get('/api/network').catch(() => null) : null;

  mount(
    el,
    html`
      <form id="settings" class="stack">
        <div class="card card-body stack">
          <h3>General</h3>
          <div class="form-grid">
            <label class="field"><span>Display name</span><input type="text" name="name" value="${s.name}" ${admin ? '' : 'disabled'} /></label>
            <label class="field">
              <span>${s.isProxy ? 'Public port' : 'Port'}</span>
              <input type="number" name="port" value="${s.port}" min="1024" max="65535" ${admin ? '' : 'disabled'} />
              <span class="hint">${s.joinedNetwork ? 'Internal port; players join through the proxy.' : s.isProxy ? 'Players connect to this port (25565 is the Minecraft default).' : 'Players connect to this port directly.'}</span>
            </label>
            <div class="field full">
              <span style="font-size:12.5px;font-weight:600;color:var(--text-2)">Java heap limit: <b style="color:var(--text)" id="mem">${(s.memoryMb / 1024).toFixed(1)} GB</b></span>
              <input type="range" name="memoryMb" min="512" max="32768" step="256" value="${s.memoryMb}" ${admin ? '' : 'disabled'} />
              <span class="hint">Java also needs memory outside its heap. Leave room for JVM overhead and the operating system.</span>
            </div>
            <label class="check">
              <input type="checkbox" name="autostart" ${s.autostart ? 'checked' : ''} />
              <div><b>Start with the panel</b><small>Start automatically when CraftPanel boots.</small></div>
            </label>
            <label class="check">
              <input type="checkbox" name="autoRestart" ${s.autoRestart ? 'checked' : ''} />
              <div><b>Restart on crash</b><small>Up to 3 times in 10 minutes.</small></div>
            </label>
            <label class="field">
              <span>Daily restart time</span>
              <input type="time" name="restartAt" value="${s.restartAt || ''}" />
              <span class="hint">Optional. Players get a 60-second warning.</span>
            </label>
          </div>
        </div>

        ${!s.isProxy && s.networkCapable && admin
          ? html`<div class="card card-body stack">
              <h3>Network</h3>
              <label class="check">
                <input type="checkbox" name="network" ${s.network ? 'checked' : ''} />
                <div>
                  <b>Join the Velocity network</b>
                  <small>
                    ${net?.enabled
                      ? 'Binds the server to 127.0.0.1, turns off online-mode and configures forwarding. Changes apply on next start.'
                      : html`The network is disabled. <a href="#/network">Enable it</a> first.`}
                  </small>
                </div>
              </label>
              <label class="field">
                <span>Custom hostname</span>
                <input type="text" name="hostname" value="${s.hostname || ''}" placeholder="${net?.domain ? `${s.id}.${net.domain}` : 'survival.example.com'}" />
                <span class="hint">Players typing this address land directly on this server. Leave blank to use the default.</span>
              </label>
            </div>`
          : ''}

        ${admin
          ? html`<div class="card card-body stack">
              <h3>Advanced</h3>
              <div class="form-grid">
                <label class="field full">
                  <span>Extra JVM arguments</span>
                  <input type="text" name="jvmArgs" value="${s.jvmArgs || ''}" placeholder="-Dfile.encoding=UTF-8" class="mono" />
                </label>
                <label class="check">
                  <input type="checkbox" name="aikarFlags" ${s.aikarFlags ? 'checked' : ''} />
                  <div><b>Use Aikar's flags</b><small>Tuned garbage collection; recommended for Paper-based servers.</small></div>
                </label>
                <label class="field">
                  <span>Server jar override</span>
                  <input type="text" name="jar" value="${s.jar || ''}" placeholder="${s.launch?.jar || (s.launch?.argsFile ? 'uses Forge/NeoForge args file' : 'server.jar')}" class="mono" />
                </label>
                <label class="field full">
                  <span>Java executable</span>
                  <input type="text" name="javaPath" value="${s.javaPath || ''}" placeholder="Automatic (matched to Minecraft ${s.mcVersion})" class="mono" />
                  <span class="hint">Leave blank to let CraftPanel pick and download the right Java version.</span>
                </label>
              </div>
            </div>`
          : ''}

        <div class="row" style="justify-content:flex-end"><button class="btn primary" type="submit">Save settings</button></div>
      </form>

      ${admin
        ? html`
            <div class="card card-body stack" style="margin-top:16px">
              <h3>Version</h3>
              <p class="muted" style="margin:0">
                Currently ${typeName(s.type)} <b>${s.mcVersion}</b>${s.loaderVersion ? html` with loader <b>${s.loaderVersion}</b>` : ''}${s.build ? html`, build ${s.build}` : ''}.
                Reinstalling downloads the server again; worlds, configs, plugins and mods are kept.
              </p>
              <div class="row"><button class="btn" id="reinstall" ${s.type === 'custom' ? 'disabled' : ''}>${icon('refresh')}Change version / reinstall…</button></div>
            </div>
            <div class="card card-body stack" style="margin-top:16px;border-color:rgba(248,81,73,.35)">
              <h3 style="color:var(--red)">Danger zone</h3>
              <p class="muted" style="margin:0">Deleting a server removes its folder and backups permanently.</p>
              <div class="row"><button class="btn solid-danger" id="delete">${icon('trash')}Delete server</button></div>
            </div>
          `
        : ''}
    `,
  );

  const f = $('#settings', el);
  f.memoryMb.oninput = () => ($('#mem', el).textContent = `${(f.memoryMb.value / 1024).toFixed(1)} GB`);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const patch = { autostart: f.autostart.checked, autoRestart: f.autoRestart.checked, restartAt: f.restartAt.value };
    if (admin) {
      Object.assign(patch, { name: f.name.value, port: Number(f.port.value), memoryMb: Number(f.memoryMb.value) });
      if (f.network) Object.assign(patch, { network: f.network.checked, hostname: f.hostname.value.trim() });
      if (f.jvmArgs) Object.assign(patch, { jvmArgs: f.jvmArgs.value, aikarFlags: f.aikarFlags.checked, jar: f.jar.value.trim() || null, javaPath: f.javaPath.value.trim() });
    }
    try {
      await api.patch(`/api/servers/${s.id}`, patch);
      await refreshServers();
      toast(serverById(s.id)?.status === 'running' ? 'Saved. Restart the server to apply.' : 'Settings saved');
    } catch (err) {
      toastError(err);
    }
  };

  const del = $('#delete', el);
  if (del)
    del.onclick = async () => {
      const ok = await confirmDialog({ title: `Delete ${s.name}?`, message: 'This stops the server and permanently deletes its files and backups. This cannot be undone.', confirm: 'Delete forever', danger: true });
      if (!ok) return;
      try {
        await api.del(`/api/servers/${s.id}`);
        toast(`${s.name} deleted`);
        await refreshServers();
        location.hash = '#/';
      } catch (err) {
        toastError(err);
      }
    };

  const re = $('#reinstall', el);
  if (re) re.onclick = () => reinstallDialog(s);
}

async function reinstallDialog(s) {
  const type = state.types.find((t) => t.id === s.type);
  let versions = [];
  try {
    versions = await api.get(`/api/types/${s.type}/versions?snapshots=1`);
  } catch (err) {
    return toastError(err);
  }
  modal({
    title: `Reinstall ${s.name}`,
    body: (body) => {
      mount(
        body,
        html`<div class="stack">
          <div class="callout warn">Back up first! Moving a world to an older version is not supported, and updating mods/plugins may be required.</div>
          <label class="field"><span>Minecraft version</span>
            <select name="mc">${versions.map((v) => html`<option value="${v.id}" ${v.id === s.mcVersion ? 'selected' : ''}>${v.id}${v.stable ? '' : ' (unstable)'}</option>`)}</select>
          </label>
          ${type?.hasLoader ? html`<label class="field"><span>${type.name} version</span><select name="loader"></select></label>` : ''}
        </div>`,
      );
      const mc = $('[name=mc]', body);
      const loader = $('[name=loader]', body);
      const loadLoaders = async () => {
        if (!loader) return;
        loader.innerHTML = '<option>Loading…</option>';
        const list = await api.get(`/api/types/${s.type}/loaders/${encodeURIComponent(mc.value)}`).catch(() => []);
        loader.innerHTML = String(html`${list.map((l) => html`<option value="${l.id}" ${l.id === s.loaderVersion ? 'selected' : ''}>${l.label}</option>`)}`);
      };
      mc.onchange = loadLoaders;
      loadLoaders();
    },
    actions: [
      { label: 'Cancel' },
      {
        label: 'Reinstall',
        cls: 'primary',
        onClick: async (_c, body) => {
          await api.post(`/api/servers/${s.id}/reinstall`, {
            mcVersion: $('[name=mc]', body).value,
            loaderVersion: $('[name=loader]', body)?.value || null,
          });
          toast('Reinstalling… watch the console for progress');
          location.hash = `#/server/${s.id}/console`;
        },
      },
    ],
  });
}
