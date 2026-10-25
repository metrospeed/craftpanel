// Read/modify server.properties while preserving comments and key order.
const fs = require('fs');

function parse(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#') || line.trimStart().startsWith('!')) continue;
    const idx = line.search(/[=:]/);
    if (idx === -1) continue;
    out[line.slice(0, idx).trim()] = unescape(line.slice(idx + 1).trim());
  }
  return out;
}

function unescape(v) {
  return v.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_, hex, c) =>
    hex ? String.fromCharCode(parseInt(hex, 16)) : ({ n: '\n', t: '\t', r: '\r' })[c] ?? c,
  );
}

function escape(v) {
  // Non-ASCII (like the § colour sign) as \uXXXX, which every Minecraft version reads correctly.
  return String(v)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/:/g, '\\:')
    .replace(/=/g, '\\=')
    .replace(/[^\x20-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'))
    // Java drops leading spaces from values unless the first one is escaped (centred MOTDs need them).
    .replace(/^ /, '\\ ');
}

function read(file) {
  return fs.existsSync(file) ? parse(fs.readFileSync(file, 'utf8')) : {};
}

/** Apply `changes` to the file, editing existing lines in place and appending new keys. */
function update(file, changes) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const pending = new Map(Object.entries(changes));
  const result = lines.map((line) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return line;
    const idx = line.search(/[=:]/);
    if (idx === -1) return line;
    const key = line.slice(0, idx).trim();
    if (!pending.has(key)) return line;
    const value = pending.get(key);
    pending.delete(key);
    return `${key}=${escape(value)}`;
  });
  while (result.length && result[result.length - 1] === '') result.pop();
  for (const [key, value] of pending) result.push(`${key}=${escape(value)}`);
  fs.writeFileSync(file, result.join('\n') + '\n');
}

module.exports = { parse, read, update };
