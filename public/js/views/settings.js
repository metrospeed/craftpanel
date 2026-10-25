import { api } from '../api.js';
import { html, mount, icon, bytes, duration, ago, $, $$, toast, toastError, confirmDialog } from '../ui.js';
import { state, onState } from '../state.js';
import { checkForUpdates, startUpdate } from '../update.js';

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
        ${admin ? updatesCard() : ''}
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
          ${admin ? backupCopyCard() : ''}
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

    const check = $('#update-check', page);
    if (check)
      check.onclick = async () => {
        check.disabled = true;
        await checkForUpdates(true);
        render();
      };
    const go = $('#update-go', page);
    if (go) go.onclick = () => startUpdate();

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
    const bc = $('#backup-copy', page);
    if (bc) {
      bc.onsubmit = async (e) => {
        e.preventDefault();
        try {
          const saved = await api.put('/api/settings', { backupCopy: { path: bc.copyPath.value, keep: Number(bc.copyKeep.value) || 0 } });
          sys.settings = saved;
          sys.backupCopyProblem = saved.backupCopyProblem;
          if (!saved.backupCopy.path) toast('Backup copies turned off');
          else if (saved.backupCopyProblem) toastError(`Saved, but copies can't be made yet: ${saved.backupCopyProblem}`);
          else toast('Saved. New backups are copied there too.');
          render();
        } catch (err) {
          toastError(err);
        }
      };
      const sync = $('#backup-copy-sync', page);
      if (sync)
        sync.onclick = async () => {
          try {
            await api.post('/api/settings/backup-copy/sync');
            toast('Copying existing backups. Progress is shown in each server console.');
          } catch (err) {
            toastError(err);
          }
        };
    }
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

  function backupCopyCard() {
    const c = sys.settings.backupCopy || { path: '', keep: 0 };
    return html`<form class="card card-body stack" id="backup-copy">
      <h3>Backup copies</h3>
      <div class="muted small">
        Backups are always kept on this machine for quick restores. Set a folder here (for example a NAS share mounted on this
        machine) and every backup is copied there too. If it's unavailable, backups carry on locally and the missing copies are
        made on the next backup.
      </div>
      <label class="field">
        <span>Also copy backups to</span>
        <input type="text" name="copyPath" value="${c.path}" placeholder="/mnt/nas/craftpanel" spellcheck="false" />
        <span class="hint">Leave empty to keep backups on this machine only. Each server gets its own subfolder. Mount the share outside /home (the CraftPanel service can't see /home) and give the craftpanel user write access.</span>
      </label>
      <label class="field">
        <span>Scheduled backups to keep there</span>
        <input type="number" name="copyKeep" value="${c.keep || ''}" min="0" max="1000" placeholder="Same as each server" />
        <span class="hint">Can be higher than the local number, so the NAS holds a longer history. Manual backups are never pruned.</span>
      </label>
      ${c.path
        ? sys.backupCopyProblem
          ? html`<div class="callout warn">${sys.backupCopyProblem}</div>`
          : html`<div class="callout ok">Copying backups to <span class="mono">${c.path}</span>.</div>`
        : ''}
      <div class="row wrap">
        <button class="btn primary" type="submit">Save</button>
        ${c.path && !sys.backupCopyProblem ? html`<button class="btn" type="button" id="backup-copy-sync">Copy existing backups now</button>` : ''}
      </div>
    </form>`;
  }

  function updatesCard() {
    const u = state.update;
    if (!u) return html`<div class="card card-body" style="margin-bottom:16px"><span class="spinner"></span> Checking GitHub for updates…</div>`;
    const current = `v${u.currentVersion}${u.currentCommit ? ` (${u.currentCommit})` : ''}`;
    return html`
      <div class="card" style="margin-bottom:16px">
        <div class="card-head">
          <h3>Updates</h3>
          ${u.updateAvailable ? html`<span class="badge running">Update available</span>` : u.error ? '' : html`<span class="badge">Up to date</span>`}
          <button class="btn sm" id="update-check">${icon('refresh')}Check now</button>
          ${u.updateAvailable && u.canSelfUpdate ? html`<button class="btn sm primary" id="update-go" ${u.pending ? 'disabled' : ''}>${icon('download')}${u.pending ? 'Update starting…' : 'Update now'}</button>` : ''}
        </div>
        <div class="card-body stack tight">
          <div class="muted small">
            Installed ${current} · latest on GitHub
            ${u.latestCommit ? html`<b>${u.latestVersion ? `v${u.latestVersion} ` : ''}(${u.latestCommit})</b>` : 'unknown'}
            · <a href="https://github.com/${u.repo}/commits/${u.branch}" target="_blank" rel="noopener">${u.repo}</a>
            ${u.checkedAt ? html` · checked ${ago(u.checkedAt)}` : ''}
          </div>
          ${u.error ? html`<div class="callout warn">${u.error}</div>` : ''}
          ${u.updateAvailable && u.changes.length
            ? html`<div class="small"><b>What's new</b>
                <ul style="margin:6px 0 0;padding-left:18px;line-height:1.7">
                  ${u.changes.map((c) => html`<li><code>${c.sha}</code> ${c.message}</li>`)}
                </ul></div>`
            : ''}
          ${u.updateAvailable && !u.canSelfUpdate
            ? html`<div class="callout info">One-click updates need the updater that newer installers add. Run this on the server once, after that the button works:
                <div class="mono" style="margin-top:6px;user-select:all">curl -fsSL https://raw.githubusercontent.com/${u.repo}/${u.branch}/install.sh | sudo bash</div></div>`
            : ''}
          ${u.lastLog ? html`<details class="small"><summary class="muted">Last update log (${ago(u.lastLog.at)})</summary><pre class="mono" style="white-space:pre-wrap;margin:8px 0 0">${u.lastLog.tail}</pre></details>` : ''}
        </div>
      </div>
    `;
  }

  // Re-render only when the update check result changes (onState also fires for live stats).
  let lastUpdate = state.update;
  const unsub = onState(() => {
    if (!sys || state.update === lastUpdate) return;
    lastUpdate = state.update;
    if (!page.contains(document.activeElement)) render();
  });
  if (state.user.admin && !state.update) checkForUpdates();
  await load();
  return unsub;
}
