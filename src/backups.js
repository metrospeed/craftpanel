// Backups are .tar.gz archives of the whole server folder, stored under
// data/backups/<server-id>/. Running servers are flushed with save-all first.
const fs = require('fs');
const path = require('path');
const tar = require('tar');
const store = require('./store');
const servers = require('./servers');
const { paths } = require('./config');

const EXCLUDE = new Set(['./cache', './logs', './crash-reports', './.fabric/remappedJars', './libraries']);
const busy = new Set();

const backupDir = (id) => path.join(paths.backups, id);

function list(id) {
  const dir = backupDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.tar.gz'))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, createdAt: st.mtime.toISOString(), auto: name.includes('-auto') };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function resolve(id, name) {
  const file = path.join(backupDir(id), path.basename(String(name)));
  if (!file.endsWith('.tar.gz') || !fs.existsSync(file)) throw servers.httpError(404, 'Backup not found');
  return file;
}

function waitForLog(id, pattern, timeoutMs) {
  return new Promise((done) => {
    const onLog = (sid, line) => {
      if (sid === id && pattern.test(line)) finish();
    };
    const finish = () => {
      clearTimeout(timer);
      servers.off('log', onLog);
      done();
    };
    const timer = setTimeout(finish, timeoutMs);
    servers.on('log', onLog);
  });
}

async function create(id, { auto = false, label = '' } = {}) {
  const server = servers.get(id);
  if (busy.has(id)) throw servers.httpError(409, 'A backup or restore is already running for this server');
  busy.add(id);
  const live = servers.rt(id).status === 'running' && !server.isProxy;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
  const name = `${stamp}${auto ? '-auto' : ''}${safeLabel ? '-' + safeLabel : ''}.tar.gz`;
  const dir = backupDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, name + '.part');
  servers.log(id, `Backup started${auto ? ' (scheduled)' : ''}...`);
  try {
    if (live) {
      servers.command(id, 'save-off');
      const saved = waitForLog(id, /Saved the (game|world)|All dimensions are saved|Saving chunks for level/i, 15000);
      servers.command(id, 'save-all flush');
      await saved;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await tar.c(
      {
        gzip: true,
        file: tmp,
        cwd: servers.dir(id),
        portable: true,
        filter: (p) => ![...EXCLUDE].some((ex) => p === ex || p.startsWith(ex + '/')) && !p.endsWith('session.lock'),
      },
      ['.'],
    );
    fs.renameSync(tmp, path.join(dir, name));
    server.lastBackupAt = new Date().toISOString();
    if (auto) server.lastAutoBackupAt = server.lastBackupAt;
    store.save();
    const size = fs.statSync(path.join(dir, name)).size;
    servers.log(id, `Backup complete: ${name} (${(size / 1048576).toFixed(1)} MB)`);
    return list(id).find((b) => b.name === name);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    servers.log(id, `Backup failed: ${err.message}`);
    throw err;
  } finally {
    if (live && servers.isRunning(id)) servers.command(id, 'save-on');
    busy.delete(id);
  }
}

async function restore(id, name) {
  servers.get(id);
  const file = resolve(id, name);
  if (busy.has(id)) throw servers.httpError(409, 'A backup or restore is already running for this server');
  busy.add(id);
  try {
    if (servers.isRunning(id)) {
      servers.log(id, 'Stopping server to restore backup...');
      await servers.stop(id);
    }
    const dir = servers.dir(id);
    servers.log(id, `Restoring ${name}...`);
    // Keep the downloaded libraries so Forge/NeoForge servers don't need reinstalling.
    for (const entry of fs.readdirSync(dir)) {
      if (entry === 'libraries') continue;
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
    await tar.x({ file, cwd: dir });
    servers.log(id, 'Restore complete.');
  } finally {
    busy.delete(id);
  }
}

function remove(id, name) {
  fs.rmSync(resolve(id, name), { force: true });
}

function prune(id, keep) {
  const autos = list(id).filter((b) => b.auto);
  for (const b of autos.slice(Math.max(1, keep))) fs.rmSync(path.join(backupDir(id), b.name), { force: true });
}

// Scheduler: automatic backups and daily restarts, checked once a minute.
function startScheduler() {
  const lastRestartDay = new Map();
  setInterval(async () => {
    const now = new Date();
    for (const server of store.db.servers) {
      const b = server.backup || {};
      if (b.enabled && b.intervalHours > 0 && server.installState === 'installed' && !busy.has(server.id)) {
        const last = server.lastAutoBackupAt ? Date.parse(server.lastAutoBackupAt) : 0;
        if (now - last >= b.intervalHours * 3600 * 1000) {
          create(server.id, { auto: true })
            .then(() => prune(server.id, b.keep || 7))
            .catch(() => {});
        }
      }
      if (server.restartAt && servers.rt(server.id).status === 'running') {
        const hhmm = now.toTimeString().slice(0, 5);
        const day = now.toDateString();
        if (hhmm === server.restartAt && lastRestartDay.get(server.id) !== day) {
          lastRestartDay.set(server.id, day);
          scheduledRestart(server).catch((e) => servers.log(server.id, `Scheduled restart failed: ${e.message}`));
        }
      }
    }
  }, 60 * 1000);
}

async function scheduledRestart(server) {
  const say = (msg) => {
    try {
      if (!server.isProxy) servers.command(server.id, `say ${msg}`);
    } catch {}
  };
  servers.log(server.id, 'Scheduled restart in 60 seconds.');
  say('Server restarting in 60 seconds');
  await new Promise((r) => setTimeout(r, 50000));
  say('Server restarting in 10 seconds');
  await new Promise((r) => setTimeout(r, 10000));
  await servers.restart(server.id);
}

module.exports = { list, create, restore, remove, prune, resolve, startScheduler, isBusy: (id) => busy.has(id) };
