const fs = require('fs');
const path = require('path');

/** Resolve `rel` inside `root`, refusing anything that escapes it. */
function safeJoin(root, rel = '') {
  const base = path.resolve(root);
  const target = path.resolve(base, '.' + path.sep + String(rel).replace(/\\/g, '/'));
  if (target !== base && !target.startsWith(base + path.sep)) {
    const err = new Error('Path is outside the server directory');
    err.status = 400;
    throw err;
  }
  return target;
}

/** macOS metadata that tags along when worlds are zipped or copied on a Mac; Minecraft can choke on it. */
function isMacJunk(rel) {
  return String(rel)
    .replace(/\\/g, '/')
    .split('/')
    .some((part) => part === '__MACOSX' || part === '.DS_Store' || part.startsWith('._'));
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {}
      }
    }
  }
  return total;
}

function findFile(dir, predicate, maxDepth = 6) {
  const walk = (cur, depth) => {
    if (depth > maxDepth) return null;
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isFile() && predicate(p, e.name)) return p;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const found = walk(path.join(cur, e.name), depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(dir, 0);
}

module.exports = { safeJoin, isMacJunk, dirSize, findFile };
