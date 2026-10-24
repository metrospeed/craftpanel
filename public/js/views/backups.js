import { api, on, subscribe } from '../api.js';
import { html, mount, icon, bytes, date, ago, $, $$, toast, toastError, confirmDialog } from '../ui.js';

export default async function backupsTab(el, s) {
  const base = `/api/servers/${s.id}/backups`;
  let data = null;

  async function load() {
    try {
      data = await api.get(base);
    } catch (err) {
      toastError(err);
      return;
    }
    render();
  }

  function render() {
    const sched = data.schedule || { enabled: false, intervalHours: 24, keep: 7 };
    mount(
      el,
      html`
        <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(260px,1fr);align-items:start">
          <div class="card">
            <div class="card-head">
              <h3>Backups</h3>
              ${data.busy ? html`<span class="badge starting"><span class="spinner" style="width:11px;height:11px"></span>Working…</span>` : ''}
              <button class="btn sm primary" id="create" ${data.busy ? 'disabled' : ''}>${icon('archive')}Back up now</button>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Backup</th><th>Size</th><th>Created</th><th></th></tr></thead>
                <tbody>
                  ${data.backups.map(
                    (b) => html`
                      <tr>
                        <td>
                          <div style="font-weight:600" title="${b.name}">${date(b.createdAt)}</div>
                          ${b.auto ? html`<span class="badge" style="margin-top:4px">scheduled</span>` : ''}
                        </td>
                        <td class="muted small nowrap">${bytes(b.size)}</td>
                        <td class="muted small nowrap">${ago(b.createdAt)}</td>
                        <td class="actions">
                          <button class="btn sm" data-restore="${b.name}">${icon('restart')}Restore</button>
                          <a class="btn ghost icon" href="${base}/${encodeURIComponent(b.name)}/download" title="Download">${icon('download')}</a>
                          <button class="btn ghost icon" data-delete="${b.name}" title="Delete">${icon('trash')}</button>
                        </td>
                      </tr>
                    `,
                  )}
                  ${!data.backups.length ? html`<tr><td colspan="4" class="faint" style="text-align:center;padding:30px">No backups yet.</td></tr>` : ''}
                </tbody>
              </table>
            </div>
          </div>

          <form class="card card-body stack" id="schedule">
            <h3>Automatic backups</h3>
            <label class="check">
              <input type="checkbox" name="enabled" ${sched.enabled ? 'checked' : ''} />
              <div><b>Enabled</b><small>Back up this server on a schedule, even while it's running.</small></div>
            </label>
            <label class="field">
              <span>Every</span>
              <select name="intervalHours">
                ${[1, 2, 3, 6, 12, 24, 48, 168].map((h) => html`<option value="${h}" ${Number(sched.intervalHours) === h ? 'selected' : ''}>${h === 168 ? 'week' : h === 1 ? 'hour' : h + ' hours'}</option>`)}
              </select>
            </label>
            <label class="field">
              <span>Keep the latest</span>
              <input type="number" name="keep" min="1" max="200" value="${sched.keep}" />
              <span class="hint">Older scheduled backups are deleted automatically. Manual backups are never pruned.</span>
            </label>
            <button class="btn primary" type="submit">Save schedule</button>
            <div class="faint small">Backups include the world, configs, plugins and mods. Logs, caches and downloaded libraries are skipped.</div>
          </form>
        </div>
      `,
    );

    $('#create', el).onclick = async () => {
      try {
        await api.post(base, {});
        toast('Backup started, progress is shown in the console');
        data.busy = true;
        render();
      } catch (err) {
        toastError(err);
      }
    };
    $$('[data-restore]', el).forEach((b) => {
      b.onclick = async () => {
        const ok = await confirmDialog({
          title: 'Restore backup?',
          message: `The server will be stopped and ALL current files replaced with ${b.dataset.restore}. Consider taking a backup first.`,
          confirm: 'Restore',
          danger: true,
        });
        if (!ok) return;
        b.disabled = true;
        toast('Restoring…');
        try {
          await api.post(`${base}/${encodeURIComponent(b.dataset.restore)}/restore`);
          toast('Backup restored. Start the server when ready.');
        } catch (err) {
          toastError(err);
        }
        load();
      };
    });
    $$('[data-delete]', el).forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmDialog({ title: 'Delete backup?', message: `Permanently delete ${b.dataset.delete}?`, confirm: 'Delete', danger: true }))) return;
        await api.del(`${base}/${encodeURIComponent(b.dataset.delete)}`).catch(toastError);
        load();
      };
    });
    const f = $('#schedule', el);
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api.patch(`/api/servers/${s.id}`, {
          backup: { enabled: f.enabled.checked, intervalHours: Number(f.intervalHours.value), keep: Number(f.keep.value) || 7 },
        });
        toast('Backup schedule saved');
        load();
      } catch (err) {
        toastError(err);
      }
    };
  }

  // Refresh when a backup finishes (reported through the console log stream).
  const off = on('log', (m) => {
    if (m.server === s.id && /^\[CraftPanel\] (Backup (complete|failed)|Restore complete)/.test(m.line)) load();
  });
  const unsub = subscribe(s.id);
  await load();
  return () => {
    off();
    unsub();
  };
}
