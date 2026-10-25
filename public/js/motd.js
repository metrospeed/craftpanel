// MOTD editor: a toolbar for colours and effects, the raw text, and a live
// preview that looks like the Minecraft multiplayer server list.
//
// Two formats:
//  - 'legacy': server.properties. Colour codes are stored as §x but shown and
//    typed as &x, which is easier to type.
//  - 'minimessage': the Velocity proxy (<red>, <bold>, <#ff8800>, <gradient:...>).
import { html, mount, $, $$ } from './ui.js';

const COLORS = [
  ['0', 'black', '#000000'],
  ['1', 'dark_blue', '#0000AA'],
  ['2', 'dark_green', '#00AA00'],
  ['3', 'dark_aqua', '#00AAAA'],
  ['4', 'dark_red', '#AA0000'],
  ['5', 'dark_purple', '#AA00AA'],
  ['6', 'gold', '#FFAA00'],
  ['7', 'gray', '#AAAAAA'],
  ['8', 'dark_gray', '#555555'],
  ['9', 'blue', '#5555FF'],
  ['a', 'green', '#55FF55'],
  ['b', 'aqua', '#55FFFF'],
  ['c', 'red', '#FF5555'],
  ['d', 'light_purple', '#FF55FF'],
  ['e', 'yellow', '#FFFF55'],
  ['f', 'white', '#FFFFFF'],
];
// [legacy code, MiniMessage tag, button label, title]
const EFFECTS = [
  ['l', 'bold', 'B', 'Bold'],
  ['o', 'italic', 'I', 'Italic'],
  ['n', 'underlined', 'U', 'Underline'],
  ['m', 'strikethrough', 'S', 'Strikethrough'],
  ['k', 'obfuscated', '?', 'Scrambled (constantly changing letters)'],
];
const MM_ALIASES = {
  b: 'bold', i: 'italic', em: 'italic', u: 'underlined', st: 'strikethrough', obf: 'obfuscated',
  grey: 'gray', dark_grey: 'dark_gray', br: 'newline', c: 'color', colour: 'color',
};
// The server list draws the MOTD in this grey unless a colour is set.
const DEFAULT_COLOR = '#808080';
// Usable MOTD width in Minecraft font pixels, used to centre lines.
const MAX_WIDTH = 270;
const OBF_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&?@';

const colorByName = (name) => COLORS.find((c) => c[1] === name)?.[2];
const isHex = (s) => /^#[0-9a-f]{6}$/i.test(s);
const resolveColor = (s) => (isHex(s) ? s : colorByName(MM_ALIASES[s] || s));

// Parsing: both formats become a list of characters with their style ---------

function parseLegacy(text) {
  const out = [];
  let st = {};
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '§' && i + 1 < text.length) {
      const code = text[++i].toLowerCase();
      const color = COLORS.find((c) => c[0] === code);
      // As in the game, a colour code also clears bold, italic etc.
      if (color) st = { color: color[2] };
      else if (code === 'r') st = {};
      else {
        const fx = EFFECTS.find((e) => e[0] === code);
        if (fx) st = { ...st, [fx[1]]: true };
      }
      continue;
    }
    out.push({ ch: text[i], ...st });
  }
  return out;
}

function lerpColor(stops, t) {
  if (stops.length === 1) return stops[0];
  const pos = t * (stops.length - 1);
  const i = Math.min(Math.floor(pos), stops.length - 2);
  const f = pos - i;
  const a = parseInt(stops[i].slice(1), 16);
  const b = parseInt(stops[i + 1].slice(1), 16);
  const ch = (shift) => Math.round(((a >> shift) & 255) * (1 - f) + ((b >> shift) & 255) * f);
  return '#' + ((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0');
}

function hue(t) {
  const f = (n) => {
    const k = (n + t * 6) % 6;
    return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return '#' + [f(5), f(3), f(1)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function parseMini(text) {
  const out = [];
  const stack = [];
  let st = {};
  // Gradients and rainbows colour their text once it is complete.
  const finish = (entry) => {
    if (!entry.gradient && !entry.rainbow) return;
    const chars = out.slice(entry.start).filter((c) => c.ch !== '\n');
    chars.forEach((c, k) => {
      const t = chars.length > 1 ? k / (chars.length - 1) : 0;
      c.color = entry.rainbow ? hue(t * (chars.length - 1) / chars.length) : lerpColor(entry.gradient, t);
    });
  };
  const re = /<\/?!?[#a-z_][^<>]*>/gi;
  let last = 0;
  const literal = (s) => {
    for (const ch of s) out.push({ ch, ...st });
  };
  for (let m; (m = re.exec(text)); ) {
    literal(text.slice(last, m.index));
    last = re.lastIndex;
    const inner = m[0].slice(1, -1);
    if (inner.startsWith('/')) {
      const name = MM_ALIASES[inner.slice(1).split(':')[0].toLowerCase()] || inner.slice(1).split(':')[0].toLowerCase();
      const idx = stack.findLastIndex((e) => e.names.includes(name));
      if (idx === -1) continue;
      for (const e of stack.splice(idx).reverse()) {
        finish(e);
        st = e.prev;
      }
      continue;
    }
    const negate = inner.startsWith('!');
    const parts = (negate ? inner.slice(1) : inner).split(':');
    const raw = parts[0].toLowerCase();
    const name = MM_ALIASES[raw] || raw;
    const prev = st;
    if (name === 'newline') {
      out.push({ ch: '\n', ...st });
    } else if (name === 'reset') {
      stack.splice(0).reverse().forEach(finish);
      st = {};
    } else if (EFFECTS.some((e) => e[1] === name)) {
      st = { ...st, [name]: !negate };
      stack.push({ names: [name], prev });
    } else if (resolveColor(name) || (name === 'color' && resolveColor(parts[1] || ''))) {
      st = { ...st, color: resolveColor(name) || resolveColor(parts[1]) };
      stack.push({ names: [name, 'color'], prev });
    } else if (name === 'gradient') {
      const stops = parts.slice(1).map(resolveColor).filter(Boolean);
      stack.push({ names: ['gradient'], prev, start: out.length, gradient: stops.length ? stops : ['#FFFFFF', '#000000'] });
    } else if (name === 'rainbow') {
      stack.push({ names: ['rainbow'], prev, start: out.length, rainbow: true });
    } else {
      literal(m[0]); // Not a tag we know: the game shows it as text too.
    }
  }
  literal(text.slice(last));
  stack.reverse().forEach(finish);
  return out;
}

// Minecraft font widths (including the 1px gap) for centring -----------------

const WIDTHS = { ' ': 4, '!': 2, "'": 2, ',': 2, '.': 2, ':': 2, ';': 2, i: 2, '|': 2, l: 3, '`': 3, I: 4, '[': 4, ']': 4, t: 4 };
for (const ch of '"()*<>fk{}') WIDTHS[ch] = 5;
for (const ch of '@~') WIDTHS[ch] = 7;
const lineWidth = (chars) => chars.reduce((w, c) => w + (WIDTHS[c.ch] ?? 6) + (c.bold ? 1 : 0), 0);

const FORMATS = {
  legacy: {
    parse: (raw) => parseLegacy(raw.replace(/&([0-9a-fk-or])/gi, '§$1')),
    toValue: (raw) => raw.replace(/&([0-9a-fk-or])/gi, '§$1'),
    fromValue: (v) => v.replace(/§([0-9a-fk-or])/gi, '&$1'),
    color: (c) => [`&${c[0]}`, ''],
    effect: (e) => [`&${e[0]}`, ''],
    reset: ['&r', ''],
  },
  minimessage: {
    parse: parseMini,
    toValue: (raw) => raw,
    fromValue: (v) => v,
    color: (c) => [`<${c[1]}>`, `</${c[1]}>`],
    effect: (e) => [`<${e[1]}>`, `</${e[1]}>`],
    reset: ['<reset>', ''],
  },
};

function shadow(hex) {
  const n = parseInt(hex.slice(1), 16);
  const q = (shift) => (((n >> shift) & 255) >> 2).toString(16).padStart(2, '0');
  return `#${q(16)}${q(8)}${q(0)}`;
}

function renderLine(chars) {
  const spans = [];
  for (const c of chars) {
    const key = [c.color, c.bold, c.italic, c.underlined, c.strikethrough, c.obfuscated].join('|');
    if (spans.length && spans[spans.length - 1].key === key) spans[spans.length - 1].text += c.ch;
    else spans.push({ key, text: c.ch, c });
  }
  return spans.map(({ text, c }) => {
    const color = c.color || DEFAULT_COLOR;
    const deco = [c.underlined && 'underline', c.strikethrough && 'line-through'].filter(Boolean).join(' ') || 'none';
    const style = `color:${color};text-shadow:2px 2px 0 ${shadow(color)};font-weight:${c.bold ? 800 : 400};font-style:${c.italic ? 'italic' : 'normal'};text-decoration:${deco}`;
    return html`<span class="${c.obfuscated ? 'obf' : ''}" style="${style}">${text}</span>`;
  });
}

/**
 * Mount a MOTD editor in `el`. `value` is the stored MOTD; `onChange(value)`
 * receives the stored form after every edit. `name`, `players` and `icon`
 * fill in the rest of the server-list preview.
 */
export function motdEditor(el, { value = '', format = 'legacy', name = 'Minecraft Server', players = '0/20', icon = '', fallbackIcon = '', onChange }) {
  const fmt = FORMATS[format];
  const mini = format === 'minimessage';
  mount(
    el,
    html`
      <div class="motd-editor">
        <div class="motd-tools">
          ${COLORS.map((c) => html`<button type="button" class="motd-swatch" style="background:${c[2]}" data-color="${c[0]}" title="${c[1].replace('_', ' ')}${mini ? '' : ` (&${c[0]})`}"></button>`)}
        </div>
        <div class="motd-tools">
          ${EFFECTS.map((e) => html`<button type="button" class="btn sm motd-fx" data-effect="${e[0]}" title="${e[3]}${mini ? '' : ` (&${e[0]})`}">${e[2]}</button>`)}
          <button type="button" class="btn sm" data-reset title="Clear colours and effects from here on">Reset</button>
          <span class="motd-sep"></span>
          ${mini
            ? html`
                <input type="color" data-hex value="#3ddc84" title="Custom colour" />
                <button type="button" class="btn sm" data-apply-hex>Colour</button>
                <span class="motd-sep"></span>
                <input type="color" data-grad-a value="#3ddc84" title="Gradient start" />
                <input type="color" data-grad-b value="#58a6ff" title="Gradient end" />
                <button type="button" class="btn sm" data-gradient>Gradient</button>
                <button type="button" class="btn sm" data-rainbow>Rainbow</button>
                <span class="motd-sep"></span>
              `
            : ''}
          <button type="button" class="btn sm" data-center title="Pad each line with spaces so it sits in the middle">Centre</button>
        </div>
        <textarea rows="${mini ? 3 : 2}" spellcheck="false" data-raw></textarea>
        <div class="motd-preview">
          <img class="motd-icon" alt="" src="${icon || fallbackIcon}" />
          <div class="motd-body">
            <div class="motd-head"><span class="motd-name">${name}</span><span class="motd-players">${players}</span></div>
            <div class="motd-lines"></div>
          </div>
        </div>
        <span class="hint" data-hint></span>
      </div>
    `,
  );
  const ta = $('[data-raw]', el);
  const lines = $('.motd-lines', el);
  const hint = $('[data-hint]', el);
  const img = $('.motd-icon', el);
  img.onerror = () => {
    img.onerror = null;
    if (fallbackIcon) img.src = fallbackIcon;
  };
  ta.value = fmt.fromValue(value);

  const baseHint = mini
    ? 'Select text and click a colour or effect to wrap it, e.g. <gold>My <bold>Network</bold></gold>.'
    : 'Select text and click a colour or effect, or type & codes (e.g. &6&lGold bold). Pick the colour first: a colour code clears effects before it.';
  function update() {
    const chars = fmt.parse(ta.value);
    const rows = [[]];
    for (const c of chars) c.ch === '\n' ? rows.push([]) : rows[rows.length - 1].push(c);
    mount(lines, html`${rows.slice(0, 2).map((r) => html`<div class="motd-line">${renderLine(r)}${r.length ? '' : ' '}</div>`)}`);
    const tooWide = rows.some((r) => lineWidth(r) > MAX_WIDTH);
    hint.textContent =
      rows.length > 2
        ? 'Only the first two lines are shown in the server list.'
        : tooWide
          ? 'A line is wider than the server list, so the end gets cut off.'
          : baseHint;
    hint.classList.toggle('warn-text', rows.length > 2 || tooWide);
    onChange?.(fmt.toValue(ta.value));
  }

  function wrap([before, after]) {
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    ta.value = v.slice(0, s) + before + v.slice(s, e) + after + v.slice(e);
    ta.focus();
    ta.setSelectionRange(s + before.length, e + before.length);
    update();
  }

  $$('[data-color]', el).forEach((b) => (b.onclick = () => wrap(fmt.color(COLORS.find((c) => c[0] === b.dataset.color)))));
  $$('[data-effect]', el).forEach((b) => (b.onclick = () => wrap(fmt.effect(EFFECTS.find((x) => x[0] === b.dataset.effect)))));
  $('[data-reset]', el).onclick = () => wrap(fmt.reset);
  if (mini) {
    $('[data-apply-hex]', el).onclick = () => {
      const hex = $('[data-hex]', el).value;
      wrap([`<${hex}>`, `</${hex}>`]);
    };
    $('[data-gradient]', el).onclick = () => wrap([`<gradient:${$('[data-grad-a]', el).value}:${$('[data-grad-b]', el).value}>`, '</gradient>']);
    $('[data-rainbow]', el).onclick = () => wrap(['<rainbow>', '</rainbow>']);
  }
  $('[data-center]', el).onclick = () => {
    ta.value = ta.value
      .split('\n')
      .map((line) => {
        const text = line.replace(/^ +/, '');
        const pad = Math.max(0, Math.floor((MAX_WIDTH - lineWidth(fmt.parse(text))) / 8));
        return ' '.repeat(pad) + text;
      })
      .join('\n');
    update();
  };
  ta.oninput = update;

  // Scrambled text keeps changing, like in the game.
  const timer = setInterval(() => {
    if (!el.isConnected) return clearInterval(timer);
    $$('.obf', lines).forEach((span) => {
      span.textContent = [...span.textContent].map((ch) => (ch === ' ' ? ch : OBF_CHARS[Math.floor(Math.random() * OBF_CHARS.length)])).join('');
    });
  }, 80);

  update();
  return { get value() { return fmt.toValue(ta.value); } };
}
