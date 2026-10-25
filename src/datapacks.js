// Datapack compatibility. Every datapack's pack.mcmeta says which data pack
// format it was made for; the server's own version.json says which format it
// runs. Packs made for another format may fail to load and stop the server
// ("Failed to load datapacks"), so the panel checks before starting and
// offers to disable a pack or swap it for a Modrinth build that matches.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const servers = require('./servers');
const props = require('./util/properties');
const http = require('./util/http');
const unzip = require('./util/unzip');
const { isMacJunk } = require('./util/fsutil');

const MODRINTH = 'https://api.modrinth.com/v2';
const DISABLED_DIR = 'disabled-datapacks';
// Paper keeps its own pack here and rewrites it on start.
const SKIP = new Set(['bukkit']);

function worldDir(server) {
  const dir = servers.dir(server.id);
  const level = props.read(path.join(dir, 'server.properties'))['level-name'] || 'world';
  return path.join(dir, level);
}

const datapackDir = (server) => path.join(worldDir(server), 'datapacks');

// --- Server format ------------------------------------------------------------

const formatCache = new Map();

/** Jars that may hold Mojang's version.json, most likely first. */
function candidateJars(server) {
  const dir = servers.dir(server.id);
  const jars = [path.join(dir, server.jar || server.launch?.jar || 'server.jar')];
  const add = (sub, test = () => true) => {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.jar') && test(f)) jars.push(path.join(d, f));
  };
  add(path.join('versions', server.mcVersion));
  add('cache', (f) => f.startsWith('mojang_'));
  add(path.join('.fabric', 'server'));
  const mcLibs = path.join(dir, 'libraries', 'net', 'minecraft', 'server');
  if (fs.existsSync(mcLibs)) {
    for (const v of fs.readdirSync(mcLibs)) add(path.join('libraries', 'net', 'minecraft', 'server', v));
  }
  return jars.filter((j) => fs.existsSync(j));
}

/** The data pack format the server runs (e.g. 121 for 26.3), or null if it can't be found yet. */
function serverFormat(server) {
  for (const jar of candidateJars(server)) {
    const key = `${jar}:${fs.statSync(jar).mtimeMs}`;
    if (formatCache.has(key)) return formatCache.get(key);
    let format = null;
    try {
      const v = JSON.parse(unzip.readEntry(jar, 'version.json') || 'null');
      const pv = v?.pack_version;
      format = typeof pv === 'number' ? pv : (pv?.data_major ?? pv?.data ?? null);
    } catch {}
    formatCache.set(key, format);
    if (format != null) return format;
  }
  return null;
}

// --- Pack formats ---------------------------------------------------------------

const major = (v) => (Array.isArray(v) ? Number(v[0]) : typeof v === 'number' ? v : null);

/** [min, max] data pack formats a pack.mcmeta declares support for, or null. */
function packRange(meta) {
  const p = meta?.pack || {};
  let min = major(p.min_format);
  let max = major(p.max_format);
  const sf = p.supported_formats;
  if (min == null && sf != null) min = typeof sf === 'number' ? sf : Array.isArray(sf) ? sf[0] : sf.min_inclusive;
  if (max == null && sf != null) max = typeof sf === 'number' ? sf : Array.isArray(sf) ? sf[1] : sf.max_inclusive;
  if (min == null) min = major(p.pack_format);
  if (max == null) max = major(p.pack_format);
  return min == null || max == null ? null : [Number(min), Number(max)];
}

function readMeta(full, isDir) {
  const raw = isDir
    ? fs.existsSync(path.join(full, 'pack.mcmeta')) && fs.readFileSync(path.join(full, 'pack.mcmeta'))
    : unzip.readEntry(full, 'pack.mcmeta');
  if (!raw) return null;
  // pack.mcmeta files sometimes carry a BOM.
  return JSON.parse(raw.toString('utf8').replace(/^﻿/, ''));
}

/** Remove macOS metadata from the datapacks folder; Minecraft tries to load ._pack.zip and fails. */
function removeJunk(server) {
  const dir = datapackDir(server);
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (isMacJunk(e.name)) {
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      } else if (e.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return removed;
}

/** Every datapack in the world with its declared formats and whether it matches the server. */
function list(server) {
  const dir = datapackDir(server);
  const format = serverFormat(server);
  if (!fs.existsSync(dir)) return { serverFormat: format, packs: [] };
  const packs = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || isMacJunk(e.name)) continue;
    const isDir = e.isDirectory();
    if (!isDir && !e.name.toLowerCase().endsWith('.zip')) continue;
    const full = path.join(dir, e.name);
    const pack = { name: e.name, folder: isDir, range: null, description: null, status: 'unknown' };
    try {
      const meta = readMeta(full, isDir);
      pack.range = packRange(meta);
      const desc = meta?.pack?.description;
      pack.description = typeof desc === 'string' ? desc : Array.isArray(desc) ? desc.map((d) => d?.text ?? d).join('') : desc?.text || null;
      if (!meta) pack.status = 'invalid';
    } catch {
      pack.status = 'invalid';
    }
    if (pack.range && format != null) {
      pack.status = format < pack.range[0] ? 'newer' : format > pack.range[1] ? 'older' : 'ok';
    }
    packs.push(pack);
  }
  return { serverFormat: format, packs };
}

// --- Modrinth ---------------------------------------------------------------------

const sha1 = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

/** For zipped packs found on Modrinth: a version of the same project made for this Minecraft version. */
async function findUpdates(server, packs) {
  const zips = packs.filter((p) => !p.folder);
  if (!zips.length) return;
  const hashes = Object.fromEntries(zips.map((p) => [sha1(path.join(datapackDir(server), p.name)), p]));
  let known;
  try {
    known = await http.postJson(`${MODRINTH}/version_files`, { hashes: Object.keys(hashes), algorithm: 'sha1' });
  } catch {
    return; // Offline: the check still works, just without update suggestions.
  }
  await Promise.all(
    Object.entries(known).map(async ([hash, version]) => {
      const pack = hashes[hash];
      pack.projectId = version.project_id;
      pack.versionNumber = version.version_number;
      try {
        const q = (v) => encodeURIComponent(JSON.stringify(v));
        const [project, versions] = await Promise.all([
          http.getJson(`${MODRINTH}/project/${version.project_id}`),
          http.getJson(`${MODRINTH}/project/${version.project_id}/version?loaders=${q(['datapack'])}&game_versions=${q([server.mcVersion])}`),
        ]);
        pack.title = project.title;
        const match = versions.find((v) => v.version_type === 'release') || versions[0];
        if (match && match.id !== version.id) pack.update = { versionId: match.id, versionNumber: match.version_number };
      } catch {}
    }),
  );
}

/** Full report used before starting and by the "Fix datapacks" dialog. */
async function check(server, { failed = [] } = {}) {
  const junkRemoved = removeJunk(server);
  const report = list(server);
  for (const p of report.packs) if (failed.includes(p.name)) p.failed = true;
  report.problems = report.packs.filter((p) => p.failed || p.status === 'older' || p.status === 'newer' || p.status === 'invalid');
  if (report.problems.length) await findUpdates(server, report.problems);
  report.junkRemoved = junkRemoved;
  report.mcVersion = server.mcVersion;
  return report;
}

function resolvePack(server, name) {
  const base = path.basename(String(name || ''));
  const full = path.join(datapackDir(server), base);
  if (!base || isMacJunk(base) || !fs.existsSync(full)) throw servers.httpError(404, 'Datapack not found');
  return { base, full };
}

/** Move a pack out of the world into <server>/disabled-datapacks (kept, not deleted). */
function disable(server, name) {
  if (servers.isRunning(server.id)) throw servers.httpError(409, 'Stop the server first');
  const { base, full } = resolvePack(server, name);
  const dest = path.join(servers.dir(server.id), DISABLED_DIR);
  fs.mkdirSync(dest, { recursive: true });
  let target = path.join(dest, base);
  if (fs.existsSync(target)) target = path.join(dest, `${Date.now()}-${base}`);
  fs.renameSync(full, target);
  servers.log(server.id, `Datapack ${base} disabled (moved to ${DISABLED_DIR}/).`);
  return { moved: path.relative(servers.dir(server.id), target).split(path.sep).join('/') };
}

/** Replace a pack with the Modrinth build for this Minecraft version; the old file is kept in disabled-datapacks. */
async function update(server, name, versionId) {
  if (servers.isRunning(server.id)) throw servers.httpError(409, 'Stop the server first');
  const { base } = resolvePack(server, name);
  const version = await http.getJson(`${MODRINTH}/version/${encodeURIComponent(versionId)}`);
  if (!version.game_versions.includes(server.mcVersion) || !version.loaders.includes('datapack')) {
    throw servers.httpError(400, `That version is not a datapack for Minecraft ${server.mcVersion}`);
  }
  const file = version.files.find((f) => f.primary) || version.files[0];
  const filename = path.basename(file.filename);
  const tmp = path.join(datapackDir(server), `.${filename}.download`);
  await http.download(file.url, tmp, { sha1: file.hashes?.sha1 });
  disable(server, base);
  fs.renameSync(tmp, path.join(datapackDir(server), filename));
  servers.log(server.id, `Datapack updated: ${base} → ${filename} (${version.version_number}).`);
  return { installed: filename };
}

/** Pack file names mentioned in a "Failed to load datapacks" log. */
function failedFromLog(lines) {
  const names = new Set();
  for (const l of lines) {
    const m = /from pack file\/([^\s]+)/.exec(l) || /Failed to open pack \S*\/datapacks\/([^\s]+)/.exec(l);
    if (m && !isMacJunk(m[1])) names.add(m[1]);
  }
  return [...names];
}

module.exports = { check, list, disable, update, removeJunk, serverFormat, packRange, failedFromLog };
