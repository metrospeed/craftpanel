// Velocity network automation. One managed Velocity proxy fronts every
// server that has "Join network" enabled. Before each start the panel
// rewrites the relevant config files so forwarding just works:
//   - velocity.toml: modern forwarding, server list, lobby and forced hosts
//   - backends: bind to 127.0.0.1, online-mode=false, forwarding secret
//     (paper-global.yml for Paper/Purpur/Folia, FabricProxy-Lite for Fabric,
//      Proxy-Compatible-Forge for Forge/NeoForge)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const YAML = require('yaml');
const TOML = require('smol-toml');
const store = require('./store');
const servers = require('./servers');
const providers = require('./providers');
const content = require('./content');
const props = require('./util/properties');
const { cmpVersion } = require('./providers/common');

const PAPER_FAMILY = ['paper', 'purpur', 'folia'];
const PROXY_MODS = { fabric: 'fabricproxy-lite', forge: 'proxy-compatible-forge', neoforge: 'proxy-compatible-forge' };

const settings = () => store.db.network;
const proxyServer = () => store.db.servers.find((s) => s.isProxy);

function inNetwork(s) {
  return settings().enabled && !!s.network && !s.isProxy && !!providers.get(s.type).network;
}

function backends() {
  return store.db.servers.filter(inNetwork);
}

/** Fingerprint of the settings a backend must be started with; a change means it needs a restart. */
function configKey(s) {
  return inNetwork(s) ? `net:${settings().secret}:${s.port}` : `solo:${s.port}`;
}

/** Safe for the proxy to route to: stopped (config applies on start) or running with current settings. */
function ready(s) {
  return !servers.isRunning(s.id) || !servers.needsRestart(s);
}

function hostnameFor(s) {
  if (s.hostname) return s.hostname;
  return settings().domain ? `${s.id}.${settings().domain}` : null;
}

function lobbyId() {
  const list = backends();
  return (list.find((s) => s.id === settings().lobby) || list[0])?.id || null;
}

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

function writeIfChanged(file, text) {
  if (readText(file) === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return true;
}

function patchYaml(file, mutate) {
  const doc = YAML.parseDocument(readText(file));
  if (!doc.contents) doc.contents = doc.createNode({});
  mutate(doc);
  writeIfChanged(file, String(doc));
}

function patchToml(file, mutate) {
  const text = readText(file);
  const cfg = text ? TOML.parse(text) : {};
  const before = JSON.stringify(cfg);
  mutate(cfg);
  // Rewriting drops the mod's comments, so only do it when a value changed.
  if (!text || JSON.stringify(cfg) !== before) writeIfChanged(file, TOML.stringify(cfg) + '\n');
}

function status() {
  const n = settings();
  const proxy = proxyServer();
  const lobby = lobbyId();
  const warnings = [];
  if (n.enabled && !n.domain) warnings.push('Set a domain so players can connect with a name instead of an IP, and to give each server its own address.');
  const list = backends();
  for (const s of list) {
    if (cmpVersion(s.mcVersion, '1.13') < 0) warnings.push(`${s.name} runs Minecraft ${s.mcVersion}; Velocity modern forwarding needs 1.13 or newer.`);
  }
  for (const s of store.db.servers.filter((x) => x.network && !providers.get(x.type).network && !x.isProxy)) {
    warnings.push(`${s.name} (${providers.get(s.type).name}) cannot join a Velocity network. Use Paper, Purpur or Fabric instead.`);
  }
  const { secret, ...rest } = n;
  return {
    ...rest,
    lobby,
    proxy: proxy ? servers.view(proxy) : null,
    servers: store.db.servers
      .filter((s) => !s.isProxy)
      .map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        port: s.port,
        capable: !!providers.get(s.type).network,
        joined: inNetwork(s),
        network: !!s.network,
        hostname: hostnameFor(s),
        customHostname: s.hostname || '',
        status: servers.view(s).status,
        restartPending: servers.needsRestart(s),
      })),
    warnings,
  };
}

async function enable(patch = {}) {
  update(patch);
  settings().enabled = true;
  store.save();
  if (!proxyServer()) {
    const versions = await providers.get('velocity').versions();
    const latest = (versions.find((v) => v.stable) || versions[0]).id;
    await servers.create({
      name: 'Velocity Proxy',
      id: 'proxy',
      type: 'velocity',
      mcVersion: latest,
      memoryMb: 512,
      port: settings().proxyPort,
      isProxy: true,
      autostart: true,
    });
  } else {
    const proxy = proxyServer();
    if (proxy.installState === 'installed' && !servers.isRunning(proxy.id)) {
      servers.start(proxy.id).catch((e) => servers.log(proxy.id, `Start failed: ${e.message}`));
    }
  }
  await syncBackends();
  return status();
}

async function disable() {
  settings().enabled = false;
  store.save();
  const proxy = proxyServer();
  if (proxy && servers.isRunning(proxy.id)) await servers.stop(proxy.id);
  await syncBackends();
  return status();
}

function update(patch = {}) {
  const n = settings();
  if ('domain' in patch) {
    const domain = String(patch.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (domain && !/^[a-z0-9.-]+$/.test(domain)) throw servers.httpError(400, 'Invalid domain');
    n.domain = domain;
  }
  if ('proxyPort' in patch) {
    const port = Number(patch.proxyPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw servers.httpError(400, 'Invalid proxy port');
    const clash = store.db.servers.find((s) => !s.isProxy && s.port === port);
    if (clash) throw servers.httpError(400, `Port ${port} is used by ${clash.name}`);
    n.proxyPort = port;
    const proxy = proxyServer();
    if (proxy) proxy.port = port;
  }
  if ('lobby' in patch) n.lobby = patch.lobby || null;
  if ('forcedHosts' in patch) n.forcedHosts = !!patch.forcedHosts;
  if ('motd' in patch) n.motd = String(patch.motd || '').slice(0, 300);
  if ('maxPlayers' in patch) n.maxPlayers = Math.max(1, Number(patch.maxPlayers) || 500);
  if (patch.regenerateSecret) n.secret = crypto.randomBytes(24).toString('base64url');
  store.save();
  syncBackends().catch(() => {});
  return status();
}

/** Start Velocity once so it writes its default config, then stop it. */
function firstBoot(server, javaBin, log) {
  const dir = servers.dir(server.id);
  if (fs.existsSync(path.join(dir, 'velocity.toml'))) return Promise.resolve();
  log('Generating default Velocity configuration...');
  return new Promise((resolve, reject) => {
    const child = spawn(javaBin, ['-Xmx256M', '-jar', server.launch.jar], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    const onData = (chunk) => {
      const text = chunk.toString();
      if (/Done \(/.test(text)) child.stdin.write('end\n');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      fs.existsSync(path.join(dir, 'velocity.toml')) ? resolve() : reject(new Error('Velocity did not generate velocity.toml'));
    });
  });
}

let configuring = Promise.resolve();

function onServersChanged() {
  configuring = configuring.then(configureProxy, configureProxy);
  return configuring;
}

let syncing = Promise.resolve();

/**
 * Bring every backend in line with the network settings right away instead of
 * waiting for its next start: stopped servers get their files rewritten, and
 * running servers that are empty restart automatically. Busy servers are left
 * alone (the proxy skips them) until someone restarts them.
 */
function syncBackends() {
  syncing = syncing.then(doSync, doSync);
  return syncing;
}

async function doSync() {
  for (const s of store.db.servers) {
    if (s.isProxy || s.type === 'custom' || s.installState !== 'installed') continue;
    const r = servers.rt(s.id);
    const log = (l) => servers.log(s.id, l);
    if (!r.child) {
      await applyConfig(s, log).catch((e) => log(`Could not apply network settings: ${e.message}`));
      continue;
    }
    // Starting/stopping servers are picked up on their next pass or start.
    if (r.status !== 'running' || !servers.needsRestart(s)) continue;
    const action = inNetwork(s) ? 'join the network' : 'apply the new network settings';
    if (!(r.players?.online > 0)) {
      log(`Restarting to ${action} (no players online).`);
      servers.restart(s.id).catch((e) => log(`Restart failed: ${e.message}`));
    } else if (r.pendingNotice !== configKey(s)) {
      r.pendingNotice = configKey(s);
      log(`Restart this server to ${action}. Players are online, so it was not restarted automatically.`);
    }
  }
  await onServersChanged();
}

async function configureProxy() {
  const proxy = proxyServer();
  if (!proxy || proxy.installState !== 'installed') return false;
  const n = settings();
  const dir = servers.dir(proxy.id);
  const file = path.join(dir, 'velocity.toml');
  if (!fs.existsSync(file)) return false;

  const list = backends().filter(ready);
  const lobby = list.some((s) => s.id === lobbyId()) ? lobbyId() : list[0]?.id || null;
  const cfg = TOML.parse(readText(file));
  cfg.bind = `0.0.0.0:${proxy.port}`;
  cfg.motd = n.motd;
  cfg['show-max-players'] = n.maxPlayers;
  cfg['online-mode'] = true;
  cfg['player-info-forwarding-mode'] = 'MODERN';
  cfg['forwarding-secret-file'] = 'forwarding.secret';
  cfg['announce-forge'] = list.some((s) => s.type === 'forge' || s.type === 'neoforge');
  cfg.servers = {};
  for (const s of list) cfg.servers[s.id] = `127.0.0.1:${s.port}`;
  cfg.servers.try = lobby ? [lobby, ...list.filter((s) => s.id !== lobby).map((s) => s.id)] : [];
  cfg['forced-hosts'] = {};
  if (n.forcedHosts) {
    for (const s of list) {
      const host = hostnameFor(s);
      if (host) cfg['forced-hosts'][host] = [s.id];
    }
  }
  const secretChanged = writeIfChanged(path.join(dir, 'forwarding.secret'), n.secret);
  const changed = writeIfChanged(file, TOML.stringify(cfg) + '\n') || secretChanged;
  if (changed && servers.rt(proxy.id).status === 'running') {
    servers.log(proxy.id, 'Network changed; reloading Velocity configuration.');
    servers.command(proxy.id, 'velocity reload');
  }
  return changed;
}

async function ensureProxyMod(server, log) {
  const slug = PROXY_MODS[server.type];
  const folder = path.join(servers.dir(server.id), 'mods');
  const current = server.proxyMod && path.join(folder, server.proxyMod);
  if (current && fs.existsSync(current)) return true;
  if (current && fs.existsSync(current + '.disabled')) {
    fs.renameSync(current + '.disabled', current);
    return true;
  }
  log(`Installing ${slug} so this server can accept connections from the Velocity proxy...`);
  try {
    const files = await content.install(server, slug, { log });
    server.proxyMod = files[0];
    store.save();
    return true;
  } catch (err) {
    log(`WARNING: could not install ${slug} for ${server.type} ${server.mcVersion} (${err.message}). Players will not be able to join this server through the proxy.`);
    return false;
  }
}

function disableProxyMod(server) {
  if (!server.proxyMod) return;
  const file = path.join(servers.dir(server.id), 'mods', server.proxyMod);
  if (fs.existsSync(file)) fs.renameSync(file, file + '.disabled');
}

/** Called right before a server starts. */
async function applyConfig(server, log = () => {}) {
  if (server.isProxy) {
    await onServersChanged();
    return;
  }
  if (server.type === 'custom') return;
  const dir = servers.dir(server.id);
  const n = settings();
  const joined = inNetwork(server);

  const changes = { 'server-port': server.port };
  if (joined) {
    Object.assign(changes, { 'server-ip': '127.0.0.1', 'online-mode': false });
  } else if (server.networkManaged) {
    Object.assign(changes, { 'server-ip': '', 'online-mode': true });
  }
  props.update(path.join(dir, 'server.properties'), changes);
  server.networkManaged = joined;
  store.save();

  if (PAPER_FAMILY.includes(server.type)) {
    const globalFile = path.join(dir, 'config', 'paper-global.yml');
    if (cmpVersion(server.mcVersion, '1.19') >= 0) {
      if (joined || fs.existsSync(globalFile)) {
        patchYaml(globalFile, (doc) => {
          doc.setIn(['proxies', 'velocity', 'enabled'], joined);
          doc.setIn(['proxies', 'velocity', 'online-mode'], true);
          doc.setIn(['proxies', 'velocity', 'secret'], n.secret);
        });
      }
    } else {
      const legacy = path.join(dir, 'paper.yml');
      if (joined || fs.existsSync(legacy)) {
        patchYaml(legacy, (doc) => {
          doc.setIn(['settings', 'velocity-support', 'enabled'], joined);
          doc.setIn(['settings', 'velocity-support', 'online-mode'], true);
          doc.setIn(['settings', 'velocity-support', 'secret'], n.secret);
        });
      }
    }
    const spigot = path.join(dir, 'spigot.yml');
    if (joined && fs.existsSync(spigot)) patchYaml(spigot, (doc) => doc.setIn(['settings', 'bungeecord'], false));
  }

  if (PROXY_MODS[server.type]) {
    if (joined) {
      await ensureProxyMod(server, log);
      if (server.type === 'fabric') {
        patchToml(path.join(dir, 'config', 'FabricProxy-Lite.toml'), (cfg) => {
          cfg.hackOnlineMode = true;
          cfg.secret = n.secret;
        });
      } else {
        patchToml(path.join(dir, 'config', 'proxy-compatible-forge.toml'), (cfg) => {
          cfg.forwarding = { ...(cfg.forwarding || {}), secret: n.secret };
        });
      }
    } else {
      disableProxyMod(server);
    }
  }
}

function env(server) {
  if (server.type === 'fabric' && inNetwork(server)) return { FABRIC_PROXY_SECRET: settings().secret };
  return {};
}

module.exports = {
  status,
  enable,
  disable,
  update,
  firstBoot,
  onServersChanged,
  syncBackends,
  configureProxy,
  applyConfig,
  env,
  inNetwork,
  hostnameFor,
  configKey,
};
