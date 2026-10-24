import { api } from '../api.js';
import { html, mount, icon, bytes, date, $, $$, toast, toastError, modal, confirmDialog, prompt } from '../ui.js';

const TEXT_EXT = /\.(txt|properties|yml|yaml|json|json5|toml|cfg|conf|ini|log|md|sh|bat|mcmeta|js|ts|csv|xml|html|css|secret|lang|snbt|mcfunction|env)$/i;
const ARCHIVE_EXT = /\.(zip|tar\.gz|tgz|tar)$/i;

export default async function filesTab(el, s) {
  const base = `/api/servers/${s.id}/files`;
  let cwd = sessionStorage.getItem(`cp-cwd-${s.id}`) || '';
  let entries = [];
  let selected = new Set();

  const join = (name) => (cwd ? `${cwd}/${name}` : name);

  async function load(path = cwd) {
    try {
      const data = await api.get(`${base}?path=${encodeURIComponent(path)}`);
      cwd = data.path;
      entries = data.entries;
    } catch (err) {
      if (path) return load('');
      toastError(err);
    }
    sessionStorage.setItem(`cp-cwd-${s.id}`, cwd);
    selected = new Set();
    render();
  }

  function render() {
    const parts = cwd ? cwd.split('/') : [];
    mount(
      el,
      html`
        <div class="card dropzone" id="drop">
          <div class="card-head" style="flex-wrap:wrap">
            <div class="crumbs grow">
              <a href="#" data-path="">${icon('folder')} ${s.id}</a>
              ${parts.map((p, i) => html`<span class="sep">/</span><a href="#" data-path="${parts.slice(0, i + 1).join('/')}">${p}</a>`)}
            </div>
            <div class="btn-group">
              <button class="btn sm danger ${selected.size ? '' : 'hidden'}" id="del-sel">${icon('trash')}Delete ${selected.size}</button>
              <button class="btn sm" id="new-file">${icon('file')}New file</button>
              <button class="btn sm" id="new-dir">${icon('folder')}New folder</button>
              <button class="btn sm primary" id="upload">${icon('upload')}Upload</button>
              <input type="file" id="upload-input" multiple class="hidden" />
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style="width:32px"><input type="checkbox" id="sel-all" /></th>
                  <th>Name</th>
                  <th style="width:110px">Size</th>
                  <th style="width:190px">Modified</th>
                  <th style="width:150px"></th>
                </tr>
              </thead>
              <tbody>
                ${cwd
                  ? html`<tr class="file-row" data-up><td></td><td colspan="4"><span class="file-name">${icon('arrowUp')} ..</span></td></tr>`
                  : ''}
                ${entries.map(
                  (e) => html`
                    <tr class="file-row" data-name="${e.name}" data-dir="${e.dir ? 1 : ''}">
                      <td><input type="checkbox" data-sel="${e.name}" ${selected.has(e.name) ? 'checked' : ''} /></td>
                      <td><span class="file-name">${icon(e.dir ? 'folder' : 'file', e.dir ? 'folder' : '')}${e.name}</span></td>
                      <td class="muted small">${e.dir ? '' : bytes(e.size)}</td>
                      <td class="muted small">${e.mtime ? date(e.mtime) : ''}</td>
                      <td class="actions">
                        ${ARCHIVE_EXT.test(e.name) && !e.dir ? html`<button class="btn ghost icon" data-extract="${e.name}" title="Extract here">${icon('unzip')}</button>` : ''}
                        <button class="btn ghost icon" data-download="${e.name}" title="Download">${icon('download')}</button>
                        <button class="btn ghost icon" data-rename="${e.name}" title="Rename">${icon('edit')}</button>
                        <button class="btn ghost icon" data-delete="${e.name}" title="Delete">${icon('trash')}</button>
                      </td>
                    </tr>
                  `,
                )}
                ${!entries.length ? html`<tr><td colspan="5" class="faint" style="text-align:center;padding:30px">This folder is empty. Drop files here to upload.</td></tr>` : ''}
              </tbody>
            </table>
          </div>
        </div>
        <div class="faint small" style="margin-top:8px">Tip: drag files or a .zip onto the list to upload, then use the extract button to unpack worlds or modpacks.</div>
      `,
    );
    bind();
  }

  function bind() {
    $$('[data-path]', el).forEach((a) => (a.onclick = (e) => (e.preventDefault(), load(a.dataset.path))));
    const up = $('[data-up]', el);
    if (up) up.onclick = () => load(cwd.split('/').slice(0, -1).join('/'));
    $$('tr[data-name]', el).forEach((tr) => {
      tr.onclick = (e) => {
        if (e.target.closest('button, input')) return;
        const name = tr.dataset.name;
        if (tr.dataset.dir) load(join(name));
        else openFile(name);
      };
    });
    $$('[data-sel]', el).forEach((c) => {
      c.onchange = () => {
        c.checked ? selected.add(c.dataset.sel) : selected.delete(c.dataset.sel);
        $('#del-sel', el).classList.toggle('hidden', !selected.size);
        $('#del-sel', el).lastChild.textContent = `Delete ${selected.size}`;
      };
    });
    $('#sel-all', el).onchange = (e) => {
      selected = e.target.checked ? new Set(entries.map((x) => x.name)) : new Set();
      render();
    };
    $('#del-sel', el).onclick = () => remove([...selected]);
    $$('[data-delete]', el).forEach((b) => (b.onclick = () => remove([b.dataset.delete])));
    $$('[data-download]', el).forEach((b) => (b.onclick = () => (location.href = `${base}/download?path=${encodeURIComponent(join(b.dataset.download))}`)));
    $$('[data-rename]', el).forEach((b) => (b.onclick = () => rename(b.dataset.rename)));
    $$('[data-extract]', el).forEach((b) => (b.onclick = () => extract(b.dataset.extract, b)));
    $('#new-file', el).onclick = async () => {
      const name = await prompt({ title: 'New file', label: 'File name', placeholder: 'notes.txt', confirm: 'Create' });
      if (!name) return;
      try {
        await api.put(`${base}/write`, { path: join(name), content: '' });
        await load();
        openFile(name);
      } catch (err) {
        toastError(err);
      }
    };
    $('#new-dir', el).onclick = async () => {
      const name = await prompt({ title: 'New folder', label: 'Folder name', confirm: 'Create' });
      if (!name) return;
      await api.post(`${base}/mkdir`, { path: join(name) }).catch(toastError);
      load();
    };
    const input = $('#upload-input', el);
    $('#upload', el).onclick = () => input.click();
    input.onchange = () => upload([...input.files]);

    const drop = $('#drop', el);
    drop.ondragover = (e) => {
      e.preventDefault();
      drop.classList.add('drag');
    };
    drop.ondragleave = (e) => {
      if (!drop.contains(e.relatedTarget)) drop.classList.remove('drag');
    };
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove('drag');
      if (e.dataTransfer.files.length) upload([...e.dataTransfer.files]);
    };
  }

  async function upload(files) {
    if (!files.length) return;
    const t = document.createElement('div');
    t.className = 'toast';
    document.getElementById('toasts').appendChild(t);
    try {
      await api.upload(`${base}/upload?path=${encodeURIComponent(cwd)}`, files, (p) => (t.textContent = `Uploading ${files.length} file(s)… ${Math.round(p * 100)}%`));
      toast(`Uploaded ${files.length} file(s)`);
    } catch (err) {
      toastError(err);
    }
    t.remove();
    load();
  }

  async function remove(names) {
    if (!names.length) return;
    const ok = await confirmDialog({
      title: 'Delete files?',
      message: names.length === 1 ? `Permanently delete "${names[0]}"?` : `Permanently delete ${names.length} items?`,
      confirm: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await api.post(`${base}/delete`, { paths: names.map(join) }).catch(toastError);
    load();
  }

  async function rename(name) {
    const next = await prompt({ title: 'Rename', label: 'New name', value: name, confirm: 'Rename' });
    if (!next || next === name) return;
    await api.post(`${base}/rename`, { from: join(name), to: join(next) }).catch(toastError);
    load();
  }

  async function extract(name, btn) {
    btn.disabled = true;
    try {
      await api.post(`${base}/extract`, { path: join(name) });
      toast(`Extracted ${name}`);
      load();
    } catch (err) {
      toastError(err);
      btn.disabled = false;
    }
  }

  async function openFile(name) {
    const path = join(name);
    const entry = entries.find((e) => e.name === name);
    if (!TEXT_EXT.test(name) && !/^[^.]+$/.test(name) && entry?.size > 0) {
      const ok = await confirmDialog({ title: 'Open file?', message: `${name} may not be a text file. Download it instead?`, confirm: 'Download' });
      if (ok) location.href = `${base}/download?path=${encodeURIComponent(path)}`;
      return;
    }
    let content;
    try {
      content = (await api.get(`${base}/read?path=${encodeURIComponent(path)}`)).content;
    } catch (err) {
      return toastError(err);
    }
    const save = async (bodyEl) => {
      await api.put(`${base}/write`, { path, content: $('textarea', bodyEl).value });
      toast(`Saved ${name}`);
    };
    const m = modal({
      title: path,
      wide: true,
      body: (body) => {
        mount(body, html`<textarea class="editor" spellcheck="false"></textarea><div class="faint small" style="margin-top:6px">Ctrl+S to save. Most config changes need a server restart.</div>`);
        const ta = $('textarea', body);
        ta.value = content;
        ta.onkeydown = (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            save(body).catch(toastError);
          } else if (e.key === 'Tab') {
            e.preventDefault();
            ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
          }
        };
      },
      actions: [
        { label: 'Close' },
        { label: 'Save', cls: 'primary', onClick: (_c, body) => save(body).then(() => false) },
      ],
    });
    setTimeout(() => $('textarea', m.body)?.focus(), 50);
  }

  await load();
}
