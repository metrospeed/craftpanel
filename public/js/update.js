import { api } from './api.js';
import { html, confirmDialog, toastError } from './ui.js';
import { state, notify } from './state.js';

export async function checkForUpdates(force = false) {
  if (!state.user?.admin) return null;
  try {
    state.update = await api.get(`/api/update${force ? '?force=1' : ''}`);
    notify();
  } catch (err) {
    if (force) toastError(err);
  }
  return state.update;
}

/** Ask the server to update itself, then wait for the new version to come back up. */
export async function startUpdate() {
  const u = state.update;
  const ok = await confirmDialog({
    title: 'Update CraftPanel?',
    message: `CraftPanel will download the latest version from GitHub (${u?.repo || 'metrospeed/craftpanel'}) and restart. Running servers are stopped safely and started again afterwards. This usually takes under a minute.`,
    confirm: 'Update now',
  });
  if (!ok) return;
  let before;
  try {
    before = await api.get('/api/auth/state');
    await api.post('/api/update');
  } catch (err) {
    return toastError(err);
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-back';
  overlay.innerHTML = String(html`
    <div class="modal" style="width:min(420px,100%)">
      <div class="modal-body" style="text-align:center;padding:30px">
        <div class="spinner" style="width:28px;height:28px;border-width:3px"></div>
        <h3 style="margin:16px 0 6px">Updating CraftPanel…</h3>
        <p class="muted small" id="update-step">Waiting for the updater to start</p>
      </div>
    </div>`);
  document.body.appendChild(overlay);
  const step = overlay.querySelector('#update-step');

  let wentDown = false;
  const started = Date.now();
  const poll = async () => {
    try {
      const s = await api.get('/api/auth/state');
      const changed = s.version !== before.version || (s.build && s.build !== before.build);
      if (wentDown || changed) {
        step.textContent = `Updated to v${s.version}${s.build ? ` (${s.build})` : ''}. Reloading…`;
        setTimeout(() => location.reload(), 1200);
        return;
      }
      step.textContent = 'Downloading the new version…';
    } catch {
      wentDown = true;
      step.textContent = 'Installing and restarting…';
    }
    if (Date.now() - started > 10 * 60 * 1000) {
      step.textContent = 'This is taking longer than expected. Check "journalctl -u craftpanel-update" on the server, then reload this page.';
      return;
    }
    setTimeout(poll, 2500);
  };
  setTimeout(poll, 2500);
}
