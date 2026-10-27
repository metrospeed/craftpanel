// Plugin & mod management backed by the Modrinth API. Installed jars are
// identified by SHA-1 hash, so manually uploaded files are recognised too.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('./util/http');
const servers = require('./servers');

const API = 'https://api.modrinth.com/v2';

const LOADERS = {
  paper: ['paper', 'spigot', 'bukkit'],
  purpur: ['purpur', 'paper', 'spigot', 'bukkit'],
  folia: ['folia'],
  velocity: ['velocity'],
  fabric: ['fabric'],
  forge: ['forge'],
  neoforge: ['neoforge'],
};

function info(server) {
  const loaders = LOADERS[server.type];
  if (!loaders) throw servers.httpError(400, 'This server type does not support plugins or mods');
  const kind = ['fabric', 'forge', 'neoforge'].includes(server.type) ? 'mods' : 'plugins';
  return { loaders, kind, folder: path.join(servers.dir(server.id), kind), proxy: server.type === 'velocity' };
}

const q = (v) => encodeURIComponent(JSON.stringify(v));

async function search(server, { query = '', offset = 0, sort = 'relevance' } = {}) {
  const { loaders, kind, proxy } = info(server);
  const facets = [loaders.map((l) => `categories:${l}`), ['project_type!=modpack'], ['project_type!=resourcepack']];
  if (!proxy) facets.push([`versions:${server.mcVersion}`]);
  if (kind === 'mods') facets.push(['server_side!=unsupported']);
  const index = ['relevance', 'downloads', 'follows', 'newest', 'updated'].includes(sort) ? sort : 'relevance';
  const url = `${API}/search?query=${encodeURIComponent(query)}&facets=${q(facets)}&index=${index}&offset=${Number(offset) || 0}&limit=20`;
  const data = await http.getJson(url);
  return {
    total: data.total_hits,
    offset: data.offset,
    hits: data.hits.map((h) => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      icon: h.icon_url,
      author: h.author,
      downloads: h.downloads,
      categories: h.display_categories || h.categories,
      clientSide: h.client_side,
      serverSide: h.server_side,
    })),
  };
}

async function versionsFor(server, projectId) {
  const { loaders, proxy } = info(server);
  let url = `${API}/project/${encodeURIComponent(projectId)}/version?loaders=${q(loaders)}`;
  if (!proxy) url += `&game_versions=${q([server.mcVersion])}`;
  return http.getJson(url);
}

function pickVersion(versions) {
  return versions.find((v) => v.version_type === 'release') || versions[0];
}

/** Install a project (and its required dependencies) into the server. */
async function install(server, projectId, { versionId, log = () => {}, seen = new Set() } = {}) {
  const { folder } = info(server);
  if (seen.has(projectId)) return [];
  seen.add(projectId);
  let version;
  if (versionId) {
    version = await http.getJson(`${API}/version/${encodeURIComponent(versionId)}`);
  } else {
    version = pickVersion(await versionsFor(server, projectId));
  }
  if (!version) throw servers.httpError(404, `No version of this project supports ${server.type} ${server.mcVersion}`);
  const file = version.files.find((f) => f.primary) || version.files[0];
  fs.mkdirSync(folder, { recursive: true });
  const installed = await listFiles(server);
  const existing = installed.find((f) => f.projectId === version.project_id);
  if (existing) fs.rmSync(path.join(folder, existing.file), { force: true });
  log(`Downloading ${file.filename}`);
  await http.download(file.url, path.join(folder, path.basename(file.filename)), { sha1: file.hashes?.sha1 });
  const result = [file.filename];
  for (const dep of version.dependencies || []) {
    if (dep.dependency_type !== 'required' || !dep.project_id) continue;
    if (installed.some((f) => f.projectId === dep.project_id)) continue;
    try {
      result.push(...(await install(server, dep.project_id, { log, seen })));
    } catch (err) {
      log(`Could not install dependency ${dep.project_id}: ${err.message}`);
    }
  }
  return result;
}

const hashCache = new Map();

function sha1Of(file) {
  const st = fs.statSync(file);
  const key = `${file}:${st.size}:${st.mtimeMs}`;
  if (hashCache.has(key)) return hashCache.get(key);
  const digest = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  hashCache.set(key, digest);
  return digest;
}

/** Jars in the plugins/mods folder, enriched with Modrinth metadata where known. */
async function listFiles(server) {
  const { folder } = info(server);
  if (!fs.existsSync(folder)) return [];
  const files = fs
    .readdirSync(folder)
    .filter((f) => /\.jar(\.disabled)?$/i.test(f))
    .map((f) => {
      const full = path.join(folder, f);
      return { file: f, enabled: !f.endsWith('.disabled'), size: fs.statSync(full).size, sha1: sha1Of(full) };
    });
  if (!files.length) return files;
  try {
    const versions = await http.postJson(`${API}/version_files`, { hashes: files.map((f) => f.sha1), algorithm: 'sha1' });
    const projectIds = [...new Set(Object.values(versions).map((v) => v.project_id))];
    const projects = projectIds.length ? await http.getJson(`${API}/projects?ids=${q(projectIds)}`) : [];
    const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
    for (const f of files) {
      const v = versions[f.sha1];
      if (!v) continue;
      const p = byId[v.project_id] || {};
      Object.assign(f, {
        projectId: v.project_id,
        versionId: v.id,
        versionNumber: v.version_number,
        title: p.title,
        slug: p.slug,
        icon: p.icon_url,
        description: p.description,
      });
    }
  } catch {
    // Offline or Modrinth unavailable: still list the raw files.
  }
  return files.sort((a, b) => (a.title || a.file).localeCompare(b.title || b.file));
}

async function checkUpdates(server) {
  const { loaders, proxy } = info(server);
  const files = (await listFiles(server)).filter((f) => f.versionId);
  if (!files.length) return {};
  // Update checks and both update actions should stay on stable releases.
  const body = { hashes: files.map((f) => f.sha1), algorithm: 'sha1', loaders, version_types: ['release'] };
  if (!proxy) body.game_versions = [server.mcVersion];
  const latest = await http.postJson(`${API}/version_files/update`, body);
  const updates = {};
  for (const f of files) {
    const v = latest[f.sha1];
    if (!v || v.id === f.versionId) continue;
    // Universal jars can have separate version IDs for different loaders.
    if (v.files.some((file) => file.hashes?.sha1 === f.sha1)) continue;
    updates[f.file] = { versionId: v.id, versionNumber: v.version_number };
  }
  return updates;
}

function resolveFile(server, file) {
  const { folder } = info(server);
  const name = path.basename(String(file));
  const full = path.join(folder, name);
  if (!fs.existsSync(full)) throw servers.httpError(404, 'File not found');
  return full;
}

function remove(server, file) {
  fs.rmSync(resolveFile(server, file), { force: true });
}

function toggle(server, file) {
  const full = resolveFile(server, file);
  const next = full.endsWith('.disabled') ? full.slice(0, -'.disabled'.length) : full + '.disabled';
  fs.renameSync(full, next);
  return path.basename(next);
}

module.exports = { info, search, versionsFor, install, listFiles, checkUpdates, remove, toggle, LOADERS };
