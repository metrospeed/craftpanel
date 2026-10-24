import { api } from '../api.js';
import { html, mount, icon, $, $$, toast, toastError, modal, confirmDialog } from '../ui.js';
import { state } from '../state.js';

export default async function users(page) {
  let list = [];

  async function load() {
    try {
      list = await api.get('/api/users');
    } catch (err) {
      return toastError(err);
    }
    render();
  }

  const serverName = (id) => state.servers.find((s) => s.id === id)?.name || id;

  function render() {
    mount(
      page,
      html`
        <div class="page-head">
          <div class="grow"><h1>Users</h1><div class="sub">Give friends or staff access to specific servers without making them administrators.</div></div>
          <button class="btn primary" id="add">${icon('plus')}Add user</button>
        </div>
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead><tr><th>User</th><th>Role</th><th>Server access</th><th></th></tr></thead>
              <tbody>
                ${list.map(
                  (u) => html`<tr>
                    <td><div class="row"><div class="avatar">${u.username[0].toUpperCase()}</div><b>${u.username}</b>${u.id === state.user.id ? html`<span class="badge">you</span>` : ''}</div></td>
                    <td>${u.admin ? html`<span class="badge purple">Administrator</span>` : html`<span class="badge">User</span>`}</td>
                    <td class="muted small">${u.admin ? 'All servers' : u.servers.length ? u.servers.map(serverName).join(', ') : 'None'}</td>
                    <td class="actions">
                      <button class="btn sm" data-edit="${u.id}">${icon('edit')}Edit</button>
                      ${u.id !== state.user.id ? html`<button class="btn ghost icon" data-del="${u.id}" title="Delete">${icon('trash')}</button>` : ''}
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div class="callout" style="margin-top:16px">
          Users can use the console, files, ${'plugins/mods'} and backups of the servers they are given. Only administrators can create or delete servers,
          change memory, ports or Java settings, and manage the network.
        </div>
      `,
    );
    $('#add', page).onclick = () => editUser(null);
    $$('[data-edit]', page).forEach((b) => (b.onclick = () => editUser(list.find((u) => u.id === b.dataset.edit))));
    $$('[data-del]', page).forEach((b) => {
      b.onclick = async () => {
        const u = list.find((x) => x.id === b.dataset.del);
        if (!(await confirmDialog({ title: `Delete ${u.username}?`, message: 'They will be signed out immediately.', confirm: 'Delete', danger: true }))) return;
        await api.del(`/api/users/${u.id}`).catch(toastError);
        load();
      };
    });
  }

  function editUser(u) {
    const servers = state.servers;
    modal({
      title: u ? `Edit ${u.username}` : 'Add user',
      body: html`
        <form class="stack" onsubmit="return false">
          ${u ? '' : html`<label class="field"><span>Username</span><input type="text" name="username" autocomplete="off" /></label>`}
          <label class="field"><span>${u ? 'New password (leave blank to keep)' : 'Password'}</span><input type="password" name="password" autocomplete="new-password" /></label>
          <label class="check"><input type="checkbox" name="admin" ${u?.admin ? 'checked' : ''} /><div><b>Administrator</b><small>Full access to everything.</small></div></label>
          <div class="field">
            <span style="font-size:12.5px;font-weight:600;color:var(--text-2)">Server access</span>
            <div class="stack tight" style="max-height:240px;overflow:auto;padding:4px 0">
              ${servers.map((s) => html`<label class="check"><input type="checkbox" name="srv" value="${s.id}" ${u?.servers.includes(s.id) ? 'checked' : ''} /><div><b>${s.name}</b></div></label>`)}
              ${!servers.length ? html`<span class="faint small">No servers yet.</span>` : ''}
            </div>
          </div>
        </form>
      `,
      actions: [
        { label: 'Cancel' },
        {
          label: u ? 'Save' : 'Create user',
          cls: 'primary',
          onClick: async (_c, body) => {
            const f = $('form', body);
            const payload = {
              admin: f.admin.checked,
              servers: $$('[name=srv]:checked', f).map((c) => c.value),
            };
            if (f.password.value) payload.password = f.password.value;
            if (u) await api.patch(`/api/users/${u.id}`, payload);
            else await api.post('/api/users', { ...payload, username: f.username.value.trim() });
            toast(u ? 'User updated' : 'User created');
            load();
          },
        },
      ],
    });
  }

  await load();
}
