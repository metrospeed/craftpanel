import { api } from '../api.js';
import { html, mount, icon, typeIcon, $, $$, toastError, toast } from '../ui.js';
import { state, loadTypes, refreshServers } from '../state.js';

const GROUPS = [
  ['Plugin servers', ['paper', 'purpur', 'folia']],
  ['Modded servers', ['fabric', 'neoforge', 'forge']],
  ['Other', ['vanilla', 'custom']],
];

const MEMORY_PRESETS = [1024, 2048, 4096, 6144, 8192, 12288];

export default async function create(page) {
  if (!state.user.admin) {
    mount(page, html`<div class="empty"><h3>Only administrators can create servers</h3></div>`);
    return;
  }
  const types = await loadTypes();
  const net = await api.get('/api/network').catch(() => ({ enabled: false }));
  const form = {
    type: null,
    name: '',
    mcVersion: '',
    loaderVersion: '',
    memoryMb: 2048,
    network: true,
    autostart: false,
    eula: false,
    port: '',
    unstable: false,
  };
  let versions = [];
  let loaders = [];
  let loading = false;

  const typeInfo = () => types.find((t) => t.id === form.type);

  async function loadVersions() {
    loading = true;
    render();
    try {
      versions = await api.get(`/api/types/${form.type}/versions${form.unstable ? '?snapshots=1' : ''}`);
      const visible = versions.filter((v) => v.stable || form.unstable);
      if (!visible.find((v) => v.id === form.mcVersion)) form.mcVersion = visible[0]?.id || '';
      await loadLoaders();
    } catch (err) {
      toastError(err);
      versions = [];
    }
    loading = false;
    render();
  }

  async function loadLoaders() {
    loaders = [];
    form.loaderVersion = '';
    if (!typeInfo()?.hasLoader || !form.mcVersion) return;
    loaders = await api.get(`/api/types/${form.type}/loaders/${encodeURIComponent(form.mcVersion)}`);
    form.loaderVersion = (loaders.find((l) => l.stable) || loaders[0])?.id || '';
  }

  function render() {
    const t = typeInfo();
    const visible = versions.filter((v) => v.stable || form.unstable);
    mount(
      page,
      html`
        <div class="page-head">
          <div class="grow">
            <h1>New server</h1>
            <div class="sub">Pick a server type, choose a version and CraftPanel downloads and configures everything.</div>
          </div>
        </div>

        <div class="card card-body" style="margin-bottom:18px">
          <h2>1. Server type</h2>
          ${GROUPS.map(
            ([label, ids]) => html`
              <div class="group-label">${label}</div>
              <div class="type-grid">
                ${ids
                  .map((id) => types.find((x) => x.id === id))
                  .filter(Boolean)
                  .map(
                    (x) => html`<button type="button" class="type-card ${form.type === x.id ? 'selected' : ''}" data-type="${x.id}">
                      ${typeIcon(x.id, 40)}
                      <div><h4>${x.name}</h4><p>${x.description}</p></div>
                    </button>`,
                  )}
              </div>
            `,
          )}
        </div>

        ${t
          ? html`
              <form class="card card-body stack" id="create-form">
                <h2>2. Details</h2>
                <div class="form-grid">
                  <label class="field full">
                    <span>Server name</span>
                    <input type="text" name="name" value="${form.name}" placeholder="Survival" required maxlength="40" />
                  </label>
                  ${t.id !== 'custom'
                    ? html`
                        <label class="field ${t.hasLoader ? '' : 'full'}">
                          <span>Minecraft version ${loading ? html`<span class="spinner"></span>` : ''}</span>
                          <select name="mcVersion" ${loading ? 'disabled' : ''}>
                            ${visible.map((v) => html`<option value="${v.id}" ${v.id === form.mcVersion ? 'selected' : ''}>${v.id}${v.stable ? '' : ' (unstable)'}</option>`)}
                          </select>
                          <label class="check small" style="margin-top:4px">
                            <input type="checkbox" name="unstable" ${form.unstable ? 'checked' : ''} />
                            <small>Show snapshots and pre-releases</small>
                          </label>
                        </label>
                        ${t.hasLoader
                          ? html`<label class="field">
                              <span>${t.name} version</span>
                              <select name="loaderVersion" ${loading ? 'disabled' : ''}>
                                ${loaders.map((l) => html`<option value="${l.id}" ${l.id === form.loaderVersion ? 'selected' : ''}>${l.label}${l.stable ? '' : ' (beta)'}</option>`)}
                              </select>
                              ${!loaders.length && !loading ? html`<span class="hint">No ${t.name} builds for this Minecraft version.</span>` : ''}
                            </label>`
                          : ''}
                      `
                    : ''}
                  <div class="field full">
                    <span style="font-size:12.5px;font-weight:600;color:var(--text-2)">Memory: <b style="color:var(--text)" id="mem-label">${(form.memoryMb / 1024).toFixed(1)} GB</b></span>
                    <input type="range" name="memoryMb" min="512" max="32768" step="512" value="${form.memoryMb}" />
                    <div class="mem-presets">
                      ${MEMORY_PRESETS.map((m) => html`<button type="button" class="btn sm ${m === form.memoryMb ? 'primary' : ''}" data-mem="${m}">${m / 1024} GB</button>`)}
                    </div>
                    <span class="hint">${t.content === 'mods' ? 'Modded servers usually need 4–8 GB.' : 'Small plugin servers run well on 2–4 GB.'}</span>
                  </div>
                  ${t.network
                    ? html`<label class="check full">
                        <input type="checkbox" name="network" ${form.network ? 'checked' : ''} />
                        <div>
                          <b>Join the Velocity network</b>
                          <small>
                            ${net.enabled
                              ? html`Players reach this server through ${net.domain || 'the proxy'}; forwarding is configured automatically.`
                              : html`The network is not enabled yet. You can turn it on later from the <a href="#/network">Network</a> page.`}
                          </small>
                        </div>
                      </label>`
                    : html`<div class="callout full">${t.name} servers cannot sit behind the Velocity proxy, so this one gets its own public port.</div>`}
                  <label class="field">
                    <span>Port</span>
                    <input type="number" name="port" value="${form.port}" placeholder="Automatic" min="1024" max="65535" />
                    <span class="hint">Leave blank to pick the next free port.</span>
                  </label>
                  <label class="check" style="align-self:center">
                    <input type="checkbox" name="autostart" ${form.autostart ? 'checked' : ''} />
                    <div><b>Start automatically</b><small>Start this server when the panel boots.</small></div>
                  </label>
                  <label class="check full">
                    <input type="checkbox" name="eula" ${form.eula ? 'checked' : ''} required />
                    <div>
                      <b>I agree to the Minecraft EULA</b>
                      <small>Required by Mojang to run a server. <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noopener">Read the EULA</a></small>
                    </div>
                  </label>
                </div>
                <div class="row" style="justify-content:flex-end">
                  <a class="btn ghost" href="#/">Cancel</a>
                  <button class="btn primary" type="submit" ${loading || (t.id !== 'custom' && !form.mcVersion) ? 'disabled' : ''}>
                    ${icon('plus')}Create server
                  </button>
                </div>
              </form>
            `
          : ''}
      `,
    );
    bind();
  }

  function bind() {
    $$('[data-type]', page).forEach((b) => {
      b.onclick = () => {
        if (form.type === b.dataset.type) return;
        form.type = b.dataset.type;
        if (!form.name) form.name = '';
        form.memoryMb = typeInfo().content === 'mods' ? 4096 : 2048;
        versions = [];
        loaders = [];
        form.mcVersion = '';
        if (form.type === 'custom') {
          form.mcVersion = 'custom';
          render();
        } else {
          loadVersions();
        }
        setTimeout(() => $('#create-form', page)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
      };
    });
    const f = $('#create-form', page);
    if (!f) return;
    f.name.oninput = () => (form.name = f.name.value);
    if (f.mcVersion) {
      f.mcVersion.onchange = async () => {
        form.mcVersion = f.mcVersion.value;
        loading = true;
        render();
        try {
          await loadLoaders();
        } catch (err) {
          toastError(err);
        }
        loading = false;
        render();
      };
      f.unstable.onchange = () => {
        form.unstable = f.unstable.checked;
        loadVersions();
      };
    }
    if (f.loaderVersion) f.loaderVersion.onchange = () => (form.loaderVersion = f.loaderVersion.value);
    f.memoryMb.oninput = () => {
      form.memoryMb = Number(f.memoryMb.value);
      $('#mem-label', page).textContent = `${(form.memoryMb / 1024).toFixed(1)} GB`;
      $$('[data-mem]', page).forEach((b) => b.classList.toggle('primary', Number(b.dataset.mem) === form.memoryMb));
    };
    $$('[data-mem]', page).forEach((b) => {
      b.onclick = () => {
        form.memoryMb = Number(b.dataset.mem);
        f.memoryMb.value = form.memoryMb;
        f.memoryMb.oninput();
      };
    });
    if (f.network) f.network.onchange = () => (form.network = f.network.checked);
    f.autostart.onchange = () => (form.autostart = f.autostart.checked);
    f.eula.onchange = () => (form.eula = f.eula.checked);
    f.port.oninput = () => (form.port = f.port.value);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', f);
      btn.disabled = true;
      try {
        const server = await api.post('/api/servers', {
          name: form.name,
          type: form.type,
          mcVersion: form.mcVersion,
          loaderVersion: form.loaderVersion || null,
          memoryMb: form.memoryMb,
          port: form.port ? Number(form.port) : undefined,
          network: typeInfo().network ? form.network : false,
          autostart: form.autostart,
          eula: form.eula,
        });
        toast(`${server.name} created, installing now`);
        await refreshServers();
        location.hash = `#/server/${server.id}/console`;
      } catch (err) {
        toastError(err);
        btn.disabled = false;
      }
    };
  }

  render();
}
