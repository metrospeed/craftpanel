// Datapack check before starting a server, and the "Fix datapacks" dialog.
import { api } from './api.js';
import { html, mount, icon, modal, toast, toastError, $$ } from './ui.js';

const skipCheck = (s) => s.isProxy || s.type === 'custom';

function problemText(p, report) {
  const fmt = p.range ? (p.range[0] === p.range[1] ? `${p.range[0]}` : `${p.range[0]}–${p.range[1]}`) : null;
  const server = report.serverFormat != null ? `; this server uses ${report.serverFormat}` : '';
  if (p.failed && p.status === 'ok') return 'Failed to load the last time the server started.';
  if (p.status === 'older') return `Made for an older Minecraft version (data format ${fmt}${server}).`;
  if (p.status === 'newer') return `Made for a newer Minecraft version (data format ${fmt}${server}).`;
  if (p.status === 'invalid') return 'Not a valid datapack (pack.mcmeta is missing or broken).';
  return 'Failed to load the last time the server started.';
}

/** Start a server, first checking its datapacks and asking what to do if any look incompatible. */
export async function startWithCheck(server) {
  if (!skipCheck(server)) {
    let report = null;
    try {
      report = await api.get(`/api/servers/${server.id}/datapacks`);
    } catch {
      // The check is advisory; never block a start because it failed.
    }
    if (report?.problems.length) return openDatapackDialog(server, report, { start: true });
  }
  await api.post(`/api/servers/${server.id}/start`);
}

export async function openDatapackDialog(server, report = null, { start = true } = {}) {
  const base = `/api/servers/${server.id}/datapacks`;
  let current = report;
  let busy = false;

  const m = modal({
    title: 'Datapack check',
    wide: true,
    body: (body) => render(body),
    actions: [
      { label: 'Cancel' },
      ...(start
        ? [
            {
              label: 'Start server',
              cls: 'primary',
              onClick: async () => {
                await api.post(`/api/servers/${server.id}/start`);
                toast(`Starting ${server.name}`);
              },
            },
          ]
        : []),
    ],
  });

  async function refresh() {
    current = await api.get(base);
    render(m.body);
  }

  function render(body) {
    if (!current) {
      mount(body, html`<div class="row"><span class="spinner"></span> Checking datapacks…</div>`);
      refresh().catch((err) => {
        toastError(err);
        m.close();
      });
      return;
    }
    const problems = current.problems;
    const startBtn = m?.el.querySelector('.modal-foot .primary');
    if (startBtn) startBtn.textContent = problems.length ? 'Start anyway' : 'Start server';
    mount(
      body,
      html`
        <div class="stack">
          ${problems.length
            ? html`<div class="callout warn">
                ${problems.length === 1 ? 'This datapack' : `These ${problems.length} datapacks`} in the world may not work on
                Minecraft ${current.mcVersion}. If one fails to load, the whole server refuses to start. Update or disable
                ${problems.length === 1 ? 'it' : 'them'} first, or start anyway.
              </div>`
            : html`<div class="callout ok">All datapacks look compatible with Minecraft ${current.mcVersion}.</div>`}
          ${current.junkRemoved ? html`<div class="faint small">Removed ${current.junkRemoved} macOS metadata file(s) from the datapacks folder.</div>` : ''}
          ${problems.length
            ? html`<div class="card">
                ${problems.map(
                  (p) => html`<div class="project">
                    <div class="noicon" style="display:grid;place-items:center">${icon('box')}</div>
                    <div class="info">
                      <h4>${p.title || p.name}${p.versionNumber ? html`<span class="badge">${p.versionNumber}</span>` : ''}</h4>
                      <p>${problemText(p, current)}</p>
                      <div class="tags"><span>${p.name}</span>${p.description ? html`<span>${p.description}</span>` : ''}</div>
                    </div>
                    <div class="btn-group">
                      ${p.update
                        ? html`<button class="btn sm primary" data-update="${p.name}" data-version="${p.update.versionId}" ${busy ? 'disabled' : ''}>
                            ${icon('download')}Update to ${p.update.versionNumber}
                          </button>`
                        : ''}
                      <button class="btn sm" data-disable="${p.name}" ${busy ? 'disabled' : ''}>Disable</button>
                    </div>
                  </div>`,
                )}
              </div>
              <div class="faint small">Disabled datapacks are moved to <code>disabled-datapacks/</code> in the server folder, not deleted. Updates come from Modrinth.</div>`
            : ''}
          ${current.serverFormat == null
            ? html`<div class="faint small">The server's data format isn't known until it has started once, so only packs that failed before are listed.</div>`
            : ''}
        </div>
      `,
    );
    const act = async (fn) => {
      busy = true;
      render(body);
      try {
        await fn();
      } catch (err) {
        toastError(err);
      }
      busy = false;
      await refresh().catch(toastError);
    };
    $$('[data-disable]', body).forEach((b) => {
      b.onclick = () => act(() => api.post(`${base}/disable`, { name: b.dataset.disable }).then(() => toast(`Disabled ${b.dataset.disable}`)));
    });
    $$('[data-update]', body).forEach((b) => {
      b.onclick = () =>
        act(() =>
          api
            .post(`${base}/update`, { name: b.dataset.update, versionId: b.dataset.version })
            .then((r) => toast(`Installed ${r.installed}`)),
        );
    });
  }
}
