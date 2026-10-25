import { api } from '../api.js';
import { html, mount, $, $$, toast, toastError } from '../ui.js';
import { serverById } from '../state.js';
import { serverListCard } from '../motd.js';

// Friendly editors for the most common server.properties keys.
const KNOWN = [
  ['motd', 'Server list', 'text'],
  ['max-players', 'Max players', 'number'],
  ['gamemode', 'Default game mode', ['survival', 'creative', 'adventure', 'spectator']],
  ['difficulty', 'Difficulty', ['peaceful', 'easy', 'normal', 'hard']],
  ['level-name', 'World folder', 'text'],
  ['level-seed', 'World seed', 'text', 'Only used when the world is first generated.'],
  ['view-distance', 'View distance', 'number'],
  ['simulation-distance', 'Simulation distance', 'number'],
  ['spawn-protection', 'Spawn protection radius', 'number'],
  ['pvp', 'PvP', 'bool'],
  ['hardcore', 'Hardcore', 'bool'],
  ['white-list', 'Whitelist', 'bool', 'Only players on the whitelist can join.'],
  ['enforce-whitelist', 'Enforce whitelist', 'bool'],
  ['allow-flight', 'Allow flight', 'bool', 'Prevents kicks for flying with mods like jetpacks.'],
  ['allow-nether', 'Allow Nether', 'bool'],
  ['enable-command-block', 'Command blocks', 'bool'],
  ['force-gamemode', 'Force game mode', 'bool'],
  ['generate-structures', 'Generate structures', 'bool'],
  ['spawn-monsters', 'Spawn monsters', 'bool'],
  ['online-mode', 'Online mode', 'bool', 'Verify players with Mojang. Managed automatically for network servers.'],
];
const MANAGED = new Set(['server-port']);

export default async function propertiesTab(el, s) {
  let props;
  try {
    props = await api.get(`/api/servers/${s.id}/properties`);
  } catch (err) {
    return toastError(err);
  }
  const managedNet = !!serverById(s.id)?.networkManaged;
  if (!Object.keys(props).length) {
    mount(el, html`<div class="card empty"><h3>No server.properties yet</h3><p>It is created the first time the server starts.</p></div>`);
    return;
  }
  const knownKeys = new Set(KNOWN.map((k) => k[0]));
  const others = Object.keys(props).filter((k) => !knownKeys.has(k)).sort();
  const locked = (k) => MANAGED.has(k) || (managedNet && (k === 'online-mode' || k === 'server-ip'));

  const field = ([key, label, type, hint]) => {
    if (!(key in props) && key !== 'motd') return '';
    const v = props[key] ?? '';
    const dis = locked(key) ? 'disabled' : '';
    if (key === 'motd')
      return html`<div class="field full"><span>${label}</span><div id="server-list-card"></div></div>`;
    if (type === 'bool')
      return html`<label class="check">
        <span class="switch"><input type="checkbox" data-key="${key}" ${v === 'true' ? 'checked' : ''} ${dis} /><span></span></span>
        <div><b>${label}</b>${hint ? html`<small>${hint}</small>` : ''}</div>
      </label>`;
    if (Array.isArray(type))
      return html`<label class="field"><span>${label}</span><select data-key="${key}" ${dis}>${type.map((o) => html`<option ${o === v ? 'selected' : ''}>${o}</option>`)}</select></label>`;
    return html`<label class="field ${key === 'motd' ? 'full' : ''}"><span>${label}</span><input type="${type === 'number' ? 'number' : 'text'}" data-key="${key}" value="${v}" ${dis} />${hint ? html`<span class="hint">${hint}</span>` : ''}</label>`;
  };

  mount(
    el,
    html`
      <form id="props" class="stack">
        <div class="card card-body">
          <h3 style="margin-bottom:14px">Gameplay</h3>
          <div class="form-grid">${KNOWN.filter((k) => k[2] !== 'bool').map(field)}</div>
          <hr />
          <div class="form-grid">${KNOWN.filter((k) => k[2] === 'bool').map(field)}</div>
        </div>
        <div class="card">
          <div class="card-head"><h3>All properties</h3><input type="search" id="filter" placeholder="Filter…" style="width:220px;height:30px" /></div>
          <div class="table-wrap">
            <table>
              <tbody>
                ${others.map(
                  (k) => html`<tr data-row="${k}">
                    <td class="mono" style="width:40%">${k}</td>
                    <td><input type="text" data-key="${k}" value="${props[k]}" ${locked(k) ? 'disabled title="Managed by CraftPanel"' : ''} style="height:30px" /></td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div class="row save-bar">
          <span class="faint small grow">Changes apply on the next restart. Port and network binding are managed by CraftPanel.</span>
          <button class="btn primary" type="submit">Save properties</button>
        </div>
      </form>
    `,
  );
  serverListCard($('#server-list-card', el), {
    serverId: s.id,
    format: 'legacy',
    value: props.motd ?? '',
    name: s.name,
    players: `0/${props['max-players'] || 20}`,
    fallbackIcon: `/img/types/${s.type === 'custom' ? 'custom.svg' : 'vanilla.svg'}`,
    iconNote: serverById(s.id)?.joinedNetwork ? 'Players joining through the network see the network icon instead (set it on the Network page).' : '',
    save: async (motd) => {
      await api.put(`/api/servers/${s.id}/properties`, { motd });
      props.motd = motd;
      toast(`MOTD saved${serverById(s.id)?.status === 'running' ? '. Restart to apply.' : ''}`);
    },
  });
  $('#filter', el).oninput = (e) => {
    const q = e.target.value.toLowerCase();
    $$('[data-row]', el).forEach((r) => r.classList.toggle('hidden', !r.dataset.row.includes(q)));
  };
  $('#props', el).onsubmit = async (e) => {
    e.preventDefault();
    const changes = {};
    $$('[data-key]', el).forEach((input) => {
      if (input.disabled) return;
      const v = input.type === 'checkbox' ? String(input.checked) : input.value;
      if (props[input.dataset.key] !== v) changes[input.dataset.key] = v;
    });
    if (!Object.keys(changes).length) return toast('No changes');
    try {
      await api.put(`/api/servers/${s.id}/properties`, changes);
      Object.assign(props, changes);
      toast(`Saved ${Object.keys(changes).length} change(s)${serverById(s.id)?.status === 'running' ? '. Restart to apply.' : ''}`);
    } catch (err) {
      toastError(err);
    }
  };
}
