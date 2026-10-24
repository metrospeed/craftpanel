import { api } from '../api.js';
import { html, mount, icon, bytes, compact, $, $$, toast, toastError, confirmDialog } from '../ui.js';
import { serverById } from '../state.js';

export default async function contentTab(el, s) {
  const base = `/api/servers/${s.id}/content`;
  const noun = s.content === 'mods' ? 'mod' : 'plugin';
  let mode = 'installed';
  let installed = null;
  let updates = {};
  let search = { query: '', sort: 'relevance', offset: 0, results: null, total: 0, loading: false };
  const installing = new Set();

  function shell() {
    mount(
      el,
      html`
        <div class="row between wrap" style="margin-bottom:14px">
          <div class="seg">
            <button data-mode="installed" class="${mode === 'installed' ? 'active' : ''}">Installed${installed ? ` (${installed.length})` : ''}</button>
            <button data-mode="browse" class="${mode === 'browse' ? 'active' : ''}">Browse Modrinth</button>
          </div>
          <div class="btn-group" id="tools"></div>
        </div>
        <div id="pane"></div>
      `,
    );
    $$('[data-mode]', el).forEach((b) => {
      b.onclick = () => {
        mode = b.dataset.mode;
        shell();
        mode === 'installed' ? renderInstalled() : renderBrowse();
        if (mode === 'browse' && !search.results) runSearch();
      };
    });
  }

  // Installed ---------------------------------------------------------------------

  async function loadInstalled() {
    try {
      installed = await api.get(base);
    } catch (err) {
      toastError(err);
      installed = [];
    }
    if (mode === 'installed') {
      shell();
      renderInstalled();
    }
  }

  function renderInstalled() {
    const tools = $('#tools', el);
    const nUpdates = Object.keys(updates).length;
    mount(
      tools,
      html`
        <button class="btn sm" id="check">${icon('refresh')}Check for updates</button>
        ${nUpdates ? html`<button class="btn sm primary" id="update-all">${icon('arrowUp')}Update all (${nUpdates})</button>` : ''}
        <button class="btn sm" id="up">${icon('upload')}Upload .jar</button>
        <input type="file" accept=".jar" multiple class="hidden" id="up-input" />
      `,
    );
    const pane = $('#pane', el);
    if (!installed) {
      mount(pane, html`<div class="card empty"><span class="spinner"></span></div>`);
    } else if (!installed.length) {
      mount(
        pane,
        html`<div class="card empty">
          ${icon('puzzle')}
          <h3>No ${noun}s installed</h3>
          <p>Browse thousands of ${noun}s on Modrinth and install them with one click. Dependencies are installed automatically.</p>
          <button class="btn primary" id="go-browse">${icon('search')}Browse ${noun}s</button>
        </div>`,
      );
      $('#go-browse', pane).onclick = () => $('[data-mode=browse]', el).click();
    } else {
      mount(
        pane,
        html`<div class="card">
          ${installed.map(
            (f) => html`
              <div class="project ${f.enabled ? '' : 'disabled'}">
                ${f.icon ? html`<img src="${f.icon}" alt="" loading="lazy" />` : html`<div class="noicon"></div>`}
                <div class="info">
                  <h4>
                    ${f.title || f.file}
                    ${f.versionNumber ? html`<span class="badge">${f.versionNumber}</span>` : ''}
                    ${!f.enabled ? html`<span class="badge">Disabled</span>` : ''}
                    ${updates[f.file] ? html`<span class="badge blue">Update: ${updates[f.file].versionNumber}</span>` : ''}
                  </h4>
                  <p>${f.description || (f.projectId ? '' : 'Not found on Modrinth (uploaded manually).')}</p>
                  <div class="tags"><span>${f.file}</span><span>${bytes(f.size)}</span></div>
                </div>
                <div class="btn-group">
                  ${updates[f.file] ? html`<button class="btn sm primary" data-update="${f.file}">Update</button>` : ''}
                  <button class="btn sm" data-toggle="${f.file}">${f.enabled ? 'Disable' : 'Enable'}</button>
                  <button class="btn sm danger icon" data-remove="${f.file}" title="Remove">${icon('trash')}</button>
                </div>
              </div>
            `,
          )}
        </div>
        ${serverById(s.id)?.status === 'running' ? html`<div class="faint small" style="margin-top:8px">Restart the server to apply ${noun} changes.</div>` : ''}`,
      );
    }

    $('#check', tools).onclick = async (e) => {
      e.target.disabled = true;
      try {
        updates = await api.get(`${base}/updates`);
        toast(Object.keys(updates).length ? `${Object.keys(updates).length} update(s) available` : `All ${noun}s are up to date`);
      } catch (err) {
        toastError(err);
      }
      renderInstalled();
    };
    const ua = $('#update-all', tools);
    if (ua)
      ua.onclick = async () => {
        ua.disabled = true;
        try {
          const r = await api.post(`${base}/update`);
          toast(`Updated ${r.updated} ${noun}(s)`);
          updates = {};
        } catch (err) {
          toastError(err);
        }
        loadInstalled();
      };
    const input = $('#up-input', tools);
    $('#up', tools).onclick = () => input.click();
    input.onchange = async () => {
      try {
        await api.upload(`${base}/upload`, [...input.files]);
        toast('Uploaded');
      } catch (err) {
        toastError(err);
      }
      loadInstalled();
    };
    $$('[data-toggle]', pane).forEach((b) => {
      b.onclick = async () => {
        await api.post(`${base}/toggle`, { file: b.dataset.toggle }).catch(toastError);
        loadInstalled();
      };
    });
    $$('[data-remove]', pane).forEach((b) => {
      b.onclick = async () => {
        if (!(await confirmDialog({ title: `Remove ${noun}?`, message: `Delete ${b.dataset.remove}? Its config folder is kept.`, confirm: 'Remove', danger: true }))) return;
        await api.post(`${base}/delete`, { file: b.dataset.remove }).catch(toastError);
        loadInstalled();
      };
    });
    $$('[data-update]', pane).forEach((b) => {
      b.onclick = async () => {
        b.disabled = true;
        try {
          await api.post(`${base}/update`, { file: b.dataset.update });
          delete updates[b.dataset.update];
          toast('Updated');
        } catch (err) {
          toastError(err);
        }
        loadInstalled();
      };
    });
  }

  // Browse ---------------------------------------------------------------------------

  async function runSearch(append = false) {
    search.loading = true;
    if (!append) search.offset = 0;
    renderBrowseResults();
    try {
      const r = await api.get(`${base}/search?query=${encodeURIComponent(search.query)}&sort=${search.sort}&offset=${search.offset}`);
      search.results = append ? [...(search.results || []), ...r.hits] : r.hits;
      search.total = r.total;
    } catch (err) {
      toastError(err);
      search.results = search.results || [];
    }
    search.loading = false;
    renderBrowseResults();
  }

  function renderBrowse() {
    mount($('#tools', el), html``);
    mount(
      $('#pane', el),
      html`
        <form class="row" id="search" style="margin-bottom:14px">
          <input type="search" placeholder="Search ${noun}s for ${s.type} ${s.mcVersion}…" value="${search.query}" class="grow" />
          <select style="width:170px" name="sort">
            ${[['relevance', 'Relevance'], ['downloads', 'Most downloaded'], ['follows', 'Most followed'], ['updated', 'Recently updated'], ['newest', 'Newest']].map(
              ([v, l]) => html`<option value="${v}" ${search.sort === v ? 'selected' : ''}>${l}</option>`,
            )}
          </select>
          <button class="btn primary" type="submit">${icon('search')}Search</button>
        </form>
        <div id="results"></div>
      `,
    );
    const f = $('#search', el);
    f.onsubmit = (e) => {
      e.preventDefault();
      search.query = $('input', f).value.trim();
      runSearch();
    };
    f.sort.onchange = () => {
      search.sort = f.sort.value;
      runSearch();
    };
    renderBrowseResults();
  }

  function renderBrowseResults() {
    const box = $('#results', el);
    if (!box) return;
    const installedIds = new Set((installed || []).map((f) => f.projectId).filter(Boolean));
    if (!search.results) {
      mount(box, html`<div class="card empty"><span class="spinner"></span></div>`);
      return;
    }
    mount(
      box,
      html`
        <div class="card">
          ${search.results.map(
            (p) => html`
              <div class="project">
                ${p.icon ? html`<img src="${p.icon}" alt="" loading="lazy" />` : html`<div class="noicon"></div>`}
                <div class="info">
                  <h4><a href="https://modrinth.com/project/${p.slug}" target="_blank" rel="noopener">${p.title}</a><span class="faint small" style="font-weight:400">by ${p.author}</span></h4>
                  <p>${p.description}</p>
                  <div class="tags">
                    <span>${compact(p.downloads)} downloads</span>
                    ${(p.categories || []).slice(0, 5).map((c) => html`<span>${c}</span>`)}
                  </div>
                </div>
                <div>
                  ${installedIds.has(p.id)
                    ? html`<span class="badge running">Installed</span>`
                    : installing.has(p.id)
                      ? html`<button class="btn sm" disabled><span class="spinner"></span></button>`
                      : html`<button class="btn sm primary" data-install="${p.id}">${icon('download')}Install</button>`}
                </div>
              </div>
            `,
          )}
          ${!search.results.length && !search.loading ? html`<div class="empty">No ${noun}s found for ${s.type} ${s.mcVersion}.</div>` : ''}
        </div>
        <div class="row" style="justify-content:center;margin-top:14px">
          ${search.loading
            ? html`<span class="spinner"></span>`
            : search.results.length < search.total
              ? html`<button class="btn" id="more">Load more</button>`
              : ''}
        </div>
      `,
    );
    const more = $('#more', box);
    if (more)
      more.onclick = () => {
        search.offset += 20;
        runSearch(true);
      };
    $$('[data-install]', box).forEach((b) => {
      b.onclick = async () => {
        const pid = b.dataset.install;
        installing.add(pid);
        renderBrowseResults();
        try {
          const r = await api.post(`${base}/install`, { projectId: pid });
          toast(`Installed ${r.files.join(', ')}${r.restartNeeded ? '. Restart the server to load it.' : ''}`);
          installed = await api.get(base);
        } catch (err) {
          toastError(err);
        }
        installing.delete(pid);
        renderBrowseResults();
      };
    });
  }

  shell();
  renderInstalled();
  await loadInstalled();
}
