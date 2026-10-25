// Tiny JSON-file database. The whole document lives in memory and is
// flushed to disk atomically (write temp file, then rename) after changes.
const fs = require('fs');
const crypto = require('crypto');
const { paths } = require('./config');

const defaults = () => ({
  users: [],
  sessions: {},
  servers: [],
  network: {
    enabled: false,
    domain: '',
    proxyPort: 25565,
    lobby: null,
    forcedHosts: true,
    motd: '<#09add3>A CraftPanel Network',
    maxPlayers: 500,
    secret: crypto.randomBytes(24).toString('base64url'),
  },
  settings: {
    javaMode: 'auto', // 'auto' downloads Temurin runtimes, 'system' uses java on PATH
    basePort: 25566,
    // Second folder every backup is copied to (e.g. a NAS mount); keep 0 = each server's own setting.
    backupCopy: { path: '', keep: 0 },
  },
});

let data;
let timer = null;

function load() {
  if (fs.existsSync(paths.db)) {
    const parsed = JSON.parse(fs.readFileSync(paths.db, 'utf8'));
    const d = defaults();
    data = {
      ...d,
      ...parsed,
      network: { ...d.network, ...parsed.network },
      settings: { ...d.settings, ...parsed.settings },
    };
  } else {
    data = defaults();
    saveNow();
  }
  return data;
}

function saveNow() {
  clearTimeout(timer);
  timer = null;
  const tmp = paths.db + '.tmp';
  // Holds password hashes and the forwarding secret: owner-only.
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, paths.db);
}

function save() {
  if (timer) return;
  timer = setTimeout(saveNow, 150);
}

module.exports = {
  load,
  save,
  saveNow,
  get db() {
    return data || load();
  },
};
