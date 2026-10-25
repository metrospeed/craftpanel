// Backups are .tar.gz archives of the whole server folder, stored under
// data/backups/<server-id>/. Running servers are flushed with save-all first.
// Optionally every backup is also copied to a second folder (e.g. a NAS
// mount); the local ones stay for quick restores when that is unavailable.
const fs = require('fs');
const path = require('path');
const tar = require('tar');
const store = require('./store');
const servers = require('./servers');
const { paths } = require('./config');

const EXCLUDE = new Set(['./cache', './logs', './crash-reports', './.fabric/remappedJars', './libraries']);
const busy = new Set();

const copying = new Map();

const backupDir = (id) => path.join(paths.backups, id);

// Copy location --------------------------------------------------------------

const copySettings = () => store.db.settings.backupCopy || { path: '', keep: 0 };
const copyDir = (id) => path.join(copySettings().path, id);

/** Why backups can't be copied to `root` right now, or null when they can. */
function copyProblem(root = copySettings().path) {
  if (!root) return 'No copy location is set.';
  if (!path.isAbsolute(root)) return 'The folder must be an absolute path, e.g. /mnt/nas/craftpanel.';
  let st;
  try {
    st = fs.statSync(root);
  } catch {
    return `${root} does not exist. Is the NAS mounted?`;
  }
  if (!st.isDirectory()) return `${root} is not a folder.`;
  // An unmounted NAS leaves an empty folder on the local disk; copying there
  // would silently fill this disk instead.
  fs.mkdirSync(paths.backups, { recursive: true });
  if (st.dev === fs.statSync(paths.backups).dev) {
    return `${root} is on the same disk as the local backups. If it is a NAS share, it is probably not mounted.`;
  }
  try {
    fs.accessSync(root, fs.constants.W_OK);
  } catch {
    return `CraftPanel can't write to ${root}. Give the craftpanel user write access.`;
  }
  return null;
}

function scan(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.tar.gz'))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, createdAt: st.mtime.toISOString(), auto: name.includes('-auto') };
    });
}

const newestFirst = (a, b) => b.createdAt.localeCompare(a.createdAt);

/** Backups on this machine and in the copy location, each marked with where it is. */
function list(id) {
  const byName = new Map();
  for (const b of scan(backupDir(id))) byName.set(b.name, { ...b, local: true, copy: false });
  let copyError = null;
  if (!copyProblem()) {
    try {
      for (const b of scan(copyDir(id))) {
        const known = byName.get(b.name);
        if (known) known.copy = true;
        else byName.set(b.name, { ...b, local: false, copy: true });
      }
    } catch (err) {
      copyError = err.message;
    }
  }
  const out = [...byName.values()].sort(newestFirst);
  if (copyError) out.copyError = copyError;
  return out;
}

/** Path of a backup: the local file when there is one, otherwise the copy. */
function resolve(id, name) {
  const base = path.basename(String(name));
  if (base.endsWith('.tar.gz')) {
    const local = path.join(backupDir(id), base);
    if (fs.existsSync(local)) return local;
    const copy = path.join(copyDir(id), base);
    if (!copyProblem() && fs.existsSync(copy)) return copy;
  }
  throw servers.httpError(404, 'Backup not found');
}

/**
 * Copy local backups that are missing from the copy location (catching up
 * after the NAS was unavailable), then prune old scheduled copies there.
 * Never throws: problems are logged and the local backups are unaffected.
 */
function copyOut(id) {
  const run = async () => {
    const { path: root, keep } = copySettings();
    if (!root) return;
    const log = (l) => servers.log(id, l);
    const problem = copyProblem();
    if (problem) return log(`Backup copy skipped: ${problem} The backup is kept on this machine and copied next time.`);
    const server = servers.find(id);
    const copyKeep = Math.max(1, Number(keep) || server?.backup?.keep || 7);
    const dest = copyDir(id);
    try {
      fs.mkdirSync(dest, { recursive: true });
      const local = scan(backupDir(id)).sort(newestFirst);
      // Scheduled backups beyond what the copy location keeps would only be pruned again.
      const keepAutos = new Set(local.filter((b) => b.auto).slice(0, copyKeep).map((b) => b.name));
      for (const b of local) {
        if (b.auto && !keepAutos.has(b.name)) continue;
        const target = path.join(dest, b.name);
        if (fs.existsSync(target) && fs.statSync(target).size === b.size) continue;
        const src = path.join(backupDir(id), b.name);
        await fs.promises.copyFile(src, target + '.part');
        const st = fs.statSync(src);
        fs.utimesSync(target + '.part', st.atime, st.mtime);
        fs.renameSync(target + '.part', target);
        log(`Backup copied to ${target}`);
      }
      const copies = scan(dest).filter((b) => b.auto).sort(newestFirst);
      for (const b of copies.slice(copyKeep)) fs.rmSync(path.join(dest, b.name), { force: true });
    } catch (err) {
      log(`Backup copy failed: ${err.message}. The backup is kept on this machine and copied next time.`);
    }
  };
  // One copy run at a time per server.
  const next = (copying.get(id) || Promise.resolve()).then(run);
  copying.set(id, next);
  return next;
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

async function create(id, opts = {}) {
  const backup = await snapshot(id, opts);
  // After the snapshot, so a slow copy doesn't keep world saving paused.
  await copyOut(id);
  return list(id).find((b) => b.name === backup.name) || backup;
}

async function snapshot(id, { auto = false, label = '' } = {}) {
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
    return { name, size };
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

/** Delete a backup from this machine and from the copy location. */
function remove(id, name) {
  resolve(id, name);
  const base = path.basename(String(name));
  fs.rmSync(path.join(backupDir(id), base), { force: true });
  if (!copyProblem()) fs.rmSync(path.join(copyDir(id), base), { force: true });
}

function prune(id, keep) {
  const autos = scan(backupDir(id)).filter((b) => b.auto).sort(newestFirst);
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

module.exports = { list, create, restore, remove, prune, resolve, copyProblem, copyOut, startScheduler, isBusy: (id) => busy.has(id) };
