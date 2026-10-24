import { api } from '../api.js';
import { html, mount, icon, bytes, duration, $, $$, toast, toastError, confirmDialog } from '../ui.js';
import { state } from '../state.js';

export default async function settings(page) {
  let sys = null;

  async function load() {
    try {
      sys = await api.get('/api/system');
    } catch (err) {
      return toastError(err);
    }
    render();
  }

  function render() {
    const admin = state.user.admin;
    const j = sys.java;
    mount(
      page,
      html`
        <div class="page-head"><div class="grow"><h1>Settings</h1><div class="sub">CraftPanel ${sys.version}</div></div></div>
        <div class="grid cols-2" style="align-items:start">
          <form class="card card-body stack" id="pw">
            <h3>Change password</h3>
            <label class="field"><span>Current password</span><input type="password" name="current" autocomplete="current-password" required /></label>
            <label class="field"><span>New password</span><input type="password" name="next" autocomplete="new-password" minlength="8" required /></label>
            <label class="field"><span>Confirm new password</span><input type="password" name="confirm" autocomplete="new-password" required /></label>
            <div><button class="btn primary" type="submit">Update password</button></div>
          </form>

          ${admin
            ? html`<form class="card card-body stack" id="panel">
                <h3>Panel</h3>
                <label class="field">
                  <span>Java runtimes</span>
                  <select name="javaMode">
                    <option value="auto" ${sys.settings.javaMode === 'auto' ? 'selected' : ''} ${j.autoSupported ? '' : 'disabled'}>Automatic: download the right Java for each server (recommended)</option>
                    <option value="system" ${sys.settings.javaMode === 'system' ? 'selected' : ''}>System: use "java" from PATH</option>
                  </select>
                  <span class="hint">System Java: ${j.system || 'not found'}${j.autoSupported ? '' : ' · automatic downloads are not available on this OS'}</span>
                </label>
                <label class="field">
                  <span>First port for new servers</span>
                  <input type="number" name="basePort" value="${sys.settings.basePort}" min="1024" max="65000" />
                </label>
                <div><button class="btn primary" type="submit">Save</button></div>
              </form>`
            : ''}
        </div>

        ${admin
          ? html`
              <div class="grid cols-2" style="align-items:start;margin-top:16px">
                <div class="card">
                  <div class="card-head"><h3>Installed Java runtimes</h3></div>
                  <table>
                    <tbody>
                      ${j.runtimes.map(
                        (r) => html`<tr>
                          <td><b>Java ${r.major}</b><div class="faint small mono">${r.version}</div></td>
                          <td class="actions"><button class="btn ghost icon" data-rm="${r.major}" title="Remove">${icon('trash')}</button></td>
                        </tr>`,
                      )}
                      ${!j.runtimes.length ? html`<tr><td class="faint" style="padding:20px">None yet, they are downloaded when a server needs them.</td></tr>` : ''}
                    </tbody>
                  </table>
                </div>
                <div class="card card-body stack">
                  <h3>System</h3>
                  <table class="small">
                    <tbody>
                      <tr><td class="muted">Host</td><td>${sys.system.hostname}</td></tr>
                      <tr><td class="muted">OS</td><td>${sys.system.platform}</td></tr>
                      <tr><td class="muted">CPU cores</td><td>${sys.system.cores}</td></tr>
                      <tr><td class="muted">Memory</td><td>${bytes(sys.system.totalMem - sys.system.freeMem)} used of ${bytes(sys.system.totalMem)}</td></tr>
                      <tr><td class="muted">Uptime</td><td>${duration(sys.system.uptime * 1000)}</td></tr>
                      <tr><td class="muted">Data folder</td><td class="mono">${sys.dataDir}</td></tr>
                      <tr><td class="muted">Servers on disk</td><td>${bytes(sys.diskUsage.servers)}</td></tr>
                      <tr><td class="muted">Backups on disk</td><td>${bytes(sys.diskUsage.backups)}</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>
            `
          : ''}
      `,
    );

    $('#pw', page).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.next.value !== f.confirm.value) return toastError('New passwords do not match');
      try {
        await api.post('/api/account/password', { current: f.current.value, next: f.next.value });
        toast('Password updated');
        f.reset();
      } catch (err) {
        toastError(err);
      }
    };
    const p = $('#panel', page);
    if (p)
      p.onsubmit = async (e) => {
        e.preventDefault();
        try {
          await api.put('/api/settings', { javaMode: p.javaMode.value, basePort: Number(p.basePort.value) });
          toast('Settings saved');
          load();
        } catch (err) {
          toastError(err);
        }
      };
    $$('[data-rm]', page).forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmDialog({ title: `Remove Java ${b.dataset.rm}?`, message: 'It will be downloaded again when a server needs it.', confirm: 'Remove', danger: true }))) return;
        await api.del(`/api/java/${b.dataset.rm}`).catch(toastError);
        load();
      };
    });
  }

  await load();
}
