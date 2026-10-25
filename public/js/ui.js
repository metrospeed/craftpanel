// Rendering helpers: auto-escaping templates, icons, modals and toasts.

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}
export const raw = (s) => new Raw(String(s));

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmt(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(fmt).join('');
  return esc(v);
}

/** Tagged template: interpolated values are HTML-escaped unless wrapped in raw()/html``. */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += fmt(values[i]);
  });
  return new Raw(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function mount(el, content) {
  el.innerHTML = String(content);
  return el;
}

// Formatting -----------------------------------------------------------------

export function bytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${units[i]}`;
}

export function duration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function ago(iso) {
  if (!iso) return 'never';
  const diff = Date.now() - Date.parse(iso);
  if (diff < 60000) return 'just now';
  return `${duration(diff)} ago`;
}

export function date(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function compact(n) {
  return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
}

export const STATUS_LABEL = {
  running: 'Online',
  starting: 'Starting',
  stopping: 'Stopping',
  stopped: 'Offline',
  crashed: 'Crashed',
  installing: 'Installing',
  install_failed: 'Install failed',
};

export function statusBadge(status) {
  return html`<span class="badge ${status}"><span class="dot ${status}"></span>${STATUS_LABEL[status] || status}</span>`;
}

// Project logos in public/img/types. Pixel-art ones are scaled without smoothing.
const TYPE_ICONS = {
  paper: 'paper.svg',
  purpur: 'purpur.svg',
  folia: 'folia.png',
  fabric: 'fabric.png',
  forge: 'forge.svg',
  neoforge: 'neoforge.png',
  vanilla: 'vanilla.svg',
  velocity: 'velocity.svg',
  custom: 'custom.svg',
};
const PIXEL_ART = new Set(['fabric', 'neoforge']);

export function typeIcon(type, size = 36) {
  const file = TYPE_ICONS[type] || TYPE_ICONS.custom;
  return html`<span class="type-icon" style="width:${size}px;height:${size}px"
    ><img src="/img/types/${file}" alt="${type}" class="${PIXEL_ART.has(type) ? 'pixel' : ''}" draggable="false"
  /></span>`;
}

// ANSI → HTML for console output (SGR colours incl. 256/truecolor).
const ANSI_16 = ['#3b4252', '#ff6b6b', '#5fd38d', '#f0c66b', '#6cb6ff', '#d38cff', '#4fd6d6', '#d8dee9', '#6b7d92', '#ff8f8f', '#86efac', '#fde68a', '#93c5fd', '#e9b5ff', '#7ee8e8', '#ffffff'];

export function ansiToHtml(text) {
  let out = '';
  let style = {};
  let open = false;
  const parts = text.split(/\x1b\[([\d;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) out += esc(parts[i]);
      continue;
    }
    const codes = parts[i].split(';').map(Number);
    for (let j = 0; j < codes.length; j++) {
      const c = codes[j];
      if (c === 0 || Number.isNaN(c)) style = {};
      else if (c === 1) style.bold = true;
      else if (c === 3) style.italic = true;
      else if (c === 4) style.underline = true;
      else if (c >= 30 && c <= 37) style.color = ANSI_16[c - 30];
      else if (c >= 90 && c <= 97) style.color = ANSI_16[c - 90 + 8];
      else if (c === 39) delete style.color;
      else if (c === 38 && codes[j + 1] === 2) {
        style.color = `rgb(${codes[j + 2]},${codes[j + 3]},${codes[j + 4]})`;
        j += 4;
      } else if (c === 38 && codes[j + 1] === 5) {
        const n = codes[j + 2];
        style.color = n < 16 ? ANSI_16[n] : undefined;
        j += 2;
      }
    }
    if (open) out += '</span>';
    const css = [
      style.color && `color:${style.color}`,
      style.bold && 'font-weight:700',
      style.italic && 'font-style:italic',
      style.underline && 'text-decoration:underline',
    ].filter(Boolean);
    open = css.length > 0;
    if (open) out += `<span style="${css.join(';')}">`;
  }
  if (open) out += '</span>';
  return out;
}

// Icons (Lucide-style strokes) ---------------------------------------------------

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  network: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3M12 12V8"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  restart: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  skull: '<path d="M12 2a8 8 0 0 0-8 8c0 2.5 1 4 2 5v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3c1-1 2-2.5 2-5a8 8 0 0 0-8-8z"/><circle cx="9" cy="11" r="1.5"/><circle cx="15" cy="11" r="1.5"/><path d="M10 19v3M14 19v3"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  puzzle: '<path d="M19.44 7.85c-.48.48-1.19.6-1.8.31a2.5 2.5 0 1 0 0 4.68c.61-.29 1.32-.17 1.8.31l1.56 1.56V19a2 2 0 0 1-2 2h-4.31l-1.56-1.56c-.48-.48-.6-1.19-.31-1.8a2.5 2.5 0 1 0-4.68 0c.29.61.17 1.32-.31 1.8L8.27 21H4a2 2 0 0 1-2-2v-4.27l1.56-1.56c.48-.48 1.19-.6 1.8-.31a2.5 2.5 0 1 0 0-4.68c-.61.29-1.32.17-1.8-.31L2 6.31V4a2 2 0 0 1 2-2h4.27l1.56 1.56c.48.48.6 1.19.31 1.8a2.5 2.5 0 1 0 4.68 0c-.29-.61-.17-1.32.31-1.8L14.69 2H19a2 2 0 0 1 2 2v2.31z"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>',
  sliders: '<line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  trash: '<path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  edit: '<path d="M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
  box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
  toggle: '<rect width="20" height="12" x="2" y="6" rx="6"/><circle cx="16" cy="12" r="2"/>',
  unzip: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M10 6h1M10 10h1M10 14h1M13 8h1M13 12h1"/>',
  arrowUp: '<path d="m5 12 7-7 7 7M12 19V5"/>',
};

export function icon(name, cls = '') {
  return raw(`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`);
}

// Toasts & modals ------------------------------------------------------------------

export function toast(message, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
}

export const toastError = (err) => toast(err?.message || String(err), 'error');

/**
 * Open a modal. `render(body, close)` fills the body; footer buttons are
 * described by `actions` ([{label, cls, onClick(close) => (false to keep open)}]).
 */
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = String(html`
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${title}</h3><button class="btn ghost icon" data-close>${icon('x')}</button></div>
      <div class="modal-body"></div>
      ${actions.length ? html`<div class="modal-foot"></div>` : ''}
    </div>`);
  const close = () => {
    back.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => e.target === back && close());
  $('[data-close]', back).onclick = close;
  const bodyEl = $('.modal-body', back);
  if (typeof body === 'function') body(bodyEl, close);
  else bodyEl.innerHTML = String(body ?? '');
  const foot = $('.modal-foot', back);
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.cls || ''}`;
    b.textContent = a.label;
    b.onclick = async () => {
      if (!a.onClick) return close();
      b.disabled = true;
      try {
        const keep = await a.onClick(close, bodyEl);
        if (keep !== false) close();
      } catch (err) {
        toastError(err);
      } finally {
        b.disabled = false;
      }
    };
    foot.appendChild(b);
  }
  document.body.appendChild(back);
  setTimeout(() => $('input, textarea, select', bodyEl)?.focus(), 30);
  return { close, el: back, body: bodyEl };
}

export function confirmDialog({ title, message, confirm = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    modal({
      title,
      body: html`<p class="muted">${message}</p>`,
      actions: [
        { label: 'Cancel', onClick: () => {} },
        {
          label: confirm,
          cls: danger ? 'solid-danger' : 'primary',
          onClick: () => {
            answered = true;
            resolve(true);
          },
        },
      ],
      onClose: () => !answered && resolve(false),
    });
  });
}

export function prompt({ title, label, value = '', confirm = 'Save', placeholder = '' }) {
  return new Promise((resolve) => {
    let result = null;
    modal({
      title,
      body: html`<label class="field"><span>${label}</span><input type="text" value="${value}" placeholder="${placeholder}" /></label>`,
      actions: [
        { label: 'Cancel' },
        {
          label: confirm,
          cls: 'primary',
          onClick: (_c, body) => {
            result = $('input', body).value.trim();
          },
        },
      ],
      onClose: () => resolve(result || null),
    });
    setTimeout(() => {
      const input = $('.modal-back:last-child input');
      if (!input) return;
      input.select();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') $('.modal-back:last-child .modal-foot .primary')?.click();
      });
    }, 40);
  });
}

export function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => toast('Copied to clipboard'), () => toast(text));
}
