// Server lifecycle: create, install, start/stop, console I/O and live stats.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const store = require('./store');
const { paths } = require('./config');
const providers = require('./providers');
const java = require('./java');
const props = require('./util/properties');
const procstats = require('./util/procstats');
const slp = require('./util/slp');

const MAX_LOG_LINES = 1500;
const STOP_TIMEOUT_MS = 90 * 1000;

// Aikar's widely used G1GC flags for Paper-family servers. Flags that newer
// JDKs dropped are ignored rather than preventing startup.
const AIKAR_FLAGS =
  '-XX:+IgnoreUnrecognizedVMOptions -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 ' +
  '-XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 ' +
  '-XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 ' +
  '-XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 ' +
  '-XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1';

const EDITABLE = [
  'name', 'memoryMb', 'port', 'network', 'autostart', 'autoRestart', 'jvmArgs', 'aikarFlags',
  'javaPath', 'jar', 'hostname', 'backup', 'restartAt',
];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function slugify(name) {
  return (
    String(name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'server'
  );
}

class ServerManager extends EventEmitter {
  constructor() {
    super();
    this.runtime = new Map();
    this.statsTimer = null;
  }

  rt(id) {
    if (!this.runtime.has(id)) {
      this.runtime.set(id, { status: 'stopped', logs: [], child: null, stats: null, players: null, restarts: [] });
    }
    return this.runtime.get(id);
  }

  dir(id) {
    return path.join(paths.servers, id);
  }

  all() {
    return store.db.servers;
  }

  find(id) {
    return store.db.servers.find((s) => s.id === id);
  }

  get(id) {
    const s = this.find(id);
    if (!s) throw httpError(404, 'Server not found');
    return s;
  }

  view(s) {
    const r = this.rt(s.id);
    const status = s.installState === 'installing' ? 'installing' : s.installState === 'failed' ? 'install_failed' : r.status;
    return {
      ...s,
      status,
      stats: r.stats,
      players: r.players,
      startedAt: r.startedAt || null,
      content: providers.get(s.type).content,
      networkCapable: !!providers.get(s.type).network,
      joinedNetwork: require('./network').inNetwork(s),
      networkHost: require('./network').hostnameFor(s),
      restartPending: this.needsRestart(s),
    };
  }

  /** Running with settings that no longer match the network config (joined/left, new secret, new port). */
  needsRestart(s) {
    const r = this.rt(s.id);
    if (!r.child || s.isProxy || s.type === 'custom') return false;
    return r.appliedKey !== require('./network').configKey(s);
  }

  isRunning(id) {
    return !!this.rt(id).child;
  }

  log(id, line, source = 'panel') {
    const r = this.rt(id);
    const entry = source === 'panel' ? `[CraftPanel] ${line}` : line;
    r.logs.push(entry);
    if (r.logs.length > MAX_LOG_LINES) r.logs.splice(0, r.logs.length - MAX_LOG_LINES);
    this.emit('log', id, entry);
  }

  setStatus(id, status) {
    this.rt(id).status = status;
    this.emit('status', id, status);
  }

  usedPorts(exceptId) {
    const ports = new Set(store.db.servers.filter((s) => s.id !== exceptId).map((s) => s.port));
    ports.add(store.db.network.proxyPort);
    return ports;
  }

  allocatePort() {
    const used = this.usedPorts();
    let port = store.db.settings.basePort || 25566;
    while (used.has(port)) port++;
    return port;
  }

  async create(opts) {
    const provider = providers.get(opts.type);
    const name = String(opts.name || '').trim();
    if (!name) throw httpError(400, 'Name is required');
    if (!opts.mcVersion) throw httpError(400, 'Version is required');
    if (!opts.eula && !provider.proxy) throw httpError(400, 'You must accept the Minecraft EULA');

    let id = slugify(opts.id || name);
    for (let n = 2; this.find(id) || fs.existsSync(this.dir(id)); n++) id = `${slugify(name)}-${n}`;

    const port = opts.port ? Number(opts.port) : this.allocatePort();
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw httpError(400, 'Port must be between 1024 and 65535');
    if (this.usedPorts().has(port) && !opts.isProxy) throw httpError(400, `Port ${port} is already used by another server`);

    const server = {
      id,
      name,
      type: provider.id,
      mcVersion: opts.mcVersion,
      loaderVersion: opts.loaderVersion || null,
      memoryMb: Math.max(256, Number(opts.memoryMb) || 2048),
      port,
      network: provider.network ? opts.network !== false : false,
      isProxy: !!opts.isProxy,
      autostart: !!opts.autostart,
      autoRestart: opts.autoRestart !== false,
      aikarFlags: ['paper', 'purpur', 'folia'].includes(provider.id),
      jvmArgs: '',
      javaPath: '',
      jar: null,
      launch: null,
      hostname: '',
      backup: { enabled: false, intervalHours: 24, keep: 7 },
      restartAt: '',
      installState: 'installing',
      createdAt: new Date().toISOString(),
    };
    fs.mkdirSync(this.dir(id), { recursive: true });
    if (opts.world && !provider.proxy) {
      try {
        require('./worlds').place(opts.world, this.dir(id), provider.id);
      } catch (err) {
        fs.rmSync(this.dir(id), { recursive: true, force: true });
        throw err;
      }
    }
    store.db.servers.push(server);
    store.save();
    this.emit('changed');

    if (opts.world) this.log(id, 'Imported the uploaded world.');
    this.install(id, { eula: !!opts.eula }).catch(() => {});
    return server;
  }

  async install(id, { eula = false } = {}) {
    const server = this.get(id);
    if (this.isRunning(id)) throw httpError(409, 'Stop the server before reinstalling');
    const provider = providers.get(server.type);
    const dir = this.dir(id);
    const log = (l) => this.log(id, l);
    server.installState = 'installing';
    delete server.installError;
    store.save();
    this.setStatus(id, 'installing');
    log(`Installing ${provider.name} ${server.mcVersion}${server.loaderVersion ? ' / ' + server.loaderVersion : ''}...`);
    try {
      const needsJava = ['forge', 'neoforge', 'velocity'].includes(server.type);
      const javaBin = needsJava ? await this.javaFor(server, log) : null;
      const result = await provider.install({
        dir,
        mcVersion: server.mcVersion,
        loaderVersion: server.loaderVersion,
        java: javaBin,
        log,
      });
      server.launch = result.launch;
      if (result.loaderVersion) server.loaderVersion = result.loaderVersion;
      if (result.build) server.build = result.build;
      if (eula) fs.writeFileSync(path.join(dir, 'eula.txt'), `# Accepted via CraftPanel on ${new Date().toISOString()}\neula=true\n`);
      if (!provider.proxy && server.type !== 'custom') {
        const propsFile = path.join(dir, 'server.properties');
        if (!fs.existsSync(propsFile)) props.update(propsFile, { 'server-port': server.port, motd: server.name });
      }
      if (provider.proxy) await require('./network').firstBoot(server, javaBin, log);
      // Pre-fetch the runtime so the first start is quick.
      if (!needsJava && server.type !== 'custom') await this.javaFor(server, log);
      server.installState = 'installed';
      log(server.isProxy ? 'Installation complete.' : 'Installation complete. Press Start to launch the server.');
    } catch (err) {
      server.installState = 'failed';
      server.installError = err.message;
      log(`Installation failed: ${err.message}`);
    }
    store.save();
    this.setStatus(id, 'stopped');
    this.emit('changed');
    if (server.installState === 'installed') {
      require('./network').syncBackends().catch(() => {});
      // A freshly created network proxy should come up without an extra click.
      if (server.isProxy && server.autostart && store.db.network.enabled && !this.isRunning(id)) {
        this.start(id).catch((e) => log(`Autostart failed: ${e.message}`));
      }
    }
  }

  async javaFor(server, log) {
    if (server.javaPath) return server.javaPath;
    const major = await java.requiredJava(server.type, server.mcVersion);
    return java.getJava(major, log);
  }

  buildArgs(server) {
    const mem = server.memoryMb;
    const args = [`-Xms${mem}M`, `-Xmx${mem}M`];
    if (server.aikarFlags) args.push(...AIKAR_FLAGS.split(' '));
    if (server.jvmArgs) args.push(...server.jvmArgs.split(/\s+/).filter(Boolean));
    const isProxy = providers.get(server.type).proxy;
    const jar = server.jar || server.launch?.jar;
    if (server.launch?.argsFile && !server.jar) {
      args.push(`@${server.launch.argsFile}`);
    } else {
      if (!jar) throw httpError(400, 'No server jar configured');
      args.push('-jar', jar);
    }
    if (!isProxy) args.push('nogui');
    return args;
  }

  async start(id) {
    const server = this.get(id);
    const r = this.rt(id);
    if (r.child) throw httpError(409, 'Server is already running');
    if (server.installState === 'installing') throw httpError(409, 'Server is still installing');
    if (server.installState === 'failed') throw httpError(409, 'Installation failed; reinstall the server from Settings');
    const dir = this.dir(id);
    const jar = server.jar || server.launch?.jar;
    if (jar && !server.launch?.argsFile && !fs.existsSync(path.join(dir, jar))) {
      throw httpError(400, `${jar} not found. Upload it in the Files tab.`);
    }

    this.setStatus(id, 'starting');
    const log = (l) => this.log(id, l);
    let javaBin;
    let env;
    try {
      const network = require('./network');
      await network.applyConfig(server, log);
      r.appliedKey = network.configKey(server);
      if (network.inNetwork(server)) log(`Network: listening on 127.0.0.1:${server.port} behind the Velocity proxy.`);
      env = { ...process.env, ...network.env(server) };
      javaBin = await this.javaFor(server, log);
    } catch (err) {
      log(`Start aborted: ${err.message}`);
      this.setStatus(id, 'stopped');
      throw err;
    }

    const args = this.buildArgs(server);
    log(`Starting with ${server.memoryMb} MB RAM: java ${args.filter((a) => !a.startsWith('-XX')).join(' ')}`);
    const child = spawn(javaBin, args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    r.child = child;
    r.stopping = false;
    r.startedAt = Date.now();
    r.players = null;
    // The proxy only routes to backends started with the current network settings.
    if (!server.isProxy) require('./network').onServersChanged().catch(() => {});

    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        this.log(id, line, 'server');
        if (r.status === 'starting' && /Done \(\d/.test(line)) {
          this.setStatus(id, 'running');
          setTimeout(() => this.pollPlayers(server), 1500);
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.stdin.on('error', () => {});

    child.on('error', (err) => {
      log(`Failed to launch Java: ${err.message}`);
      if (!child.pid && r.child === child) {
        r.child = null;
        this.setStatus(id, 'stopped');
      }
    });

    child.on('close', (code, signal) => {
      if (r.child !== child) return;
      if (buf) this.log(id, buf, 'server');
      procstats.forget(child.pid);
      const wasStopping = r.stopping;
      r.child = null;
      r.stats = null;
      r.players = null;
      r.startedAt = null;
      clearTimeout(r.killTimer);
      const crashed = !wasStopping && code !== 0;
      log(`Server process exited (${signal || 'code ' + code}).`);
      this.setStatus(id, crashed ? 'crashed' : 'stopped');
      r.exitWaiters?.forEach((fn) => fn());
      r.exitWaiters = [];
      if (crashed && server.autoRestart && this.find(id)) this.scheduleRestart(id);
    });
    return true;
  }

  scheduleRestart(id) {
    const r = this.rt(id);
    const now = Date.now();
    r.restarts = r.restarts.filter((t) => now - t < 10 * 60 * 1000);
    if (r.restarts.length >= 3) {
      this.log(id, 'Server crashed 3 times in 10 minutes; automatic restart disabled until you start it manually.');
      return;
    }
    r.restarts.push(now);
    this.log(id, 'Server crashed. Restarting in 10 seconds...');
    setTimeout(() => {
      if (!this.isRunning(id) && this.find(id)) this.start(id).catch((e) => this.log(id, `Auto-restart failed: ${e.message}`));
    }, 10000);
  }

  waitForExit(id) {
    const r = this.rt(id);
    if (!r.child) return Promise.resolve();
    return new Promise((resolve) => {
      r.exitWaiters = r.exitWaiters || [];
      r.exitWaiters.push(resolve);
    });
  }

  stop(id) {
    const server = this.get(id);
    const r = this.rt(id);
    if (!r.child) return Promise.resolve();
    if (!r.stopping) {
      r.stopping = true;
      this.setStatus(id, 'stopping');
      this.write(id, providers.get(server.type).proxy ? 'end' : 'stop');
      r.killTimer = setTimeout(() => {
        if (r.child) {
          this.log(id, 'Server did not stop in time; killing process.');
          r.child.kill('SIGKILL');
        }
      }, STOP_TIMEOUT_MS);
    }
    return this.waitForExit(id);
  }

  kill(id) {
    const r = this.rt(id);
    if (!r.child) return;
    r.stopping = true;
    r.child.kill('SIGKILL');
  }

  async restart(id) {
    await this.stop(id);
    await this.start(id);
  }

  write(id, text) {
    const r = this.rt(id);
    if (!r.child) throw httpError(409, 'Server is not running');
    r.child.stdin.write(text + '\n');
  }

  command(id, cmd) {
    const text = String(cmd || '').replace(/[\r\n]/g, '').trim();
    if (!text) return;
    this.log(id, `> ${text}`, 'server');
    this.write(id, text.replace(/^\//, ''));
  }

  update(id, patch) {
    const server = this.get(id);
    for (const key of EDITABLE) {
      if (!(key in patch)) continue;
      let value = patch[key];
      if (key === 'memoryMb') value = Math.max(256, Number(value) || server.memoryMb);
      if (key === 'port') {
        value = Number(value);
        if (!Number.isInteger(value) || value < 1024 || value > 65535) throw httpError(400, 'Invalid port');
        if (this.usedPorts(id).has(value) && !server.isProxy) throw httpError(400, `Port ${value} is already in use`);
      }
      if (key === 'network' && !providers.get(server.type).network) value = false;
      if (key === 'backup') value = { ...server.backup, ...value };
      if (key === 'restartAt' && value && !/^\d{2}:\d{2}$/.test(value)) throw httpError(400, 'Restart time must be HH:MM');
      if (key === 'jar' && value && (value.includes('/') || value.includes('\\'))) throw httpError(400, 'Jar must be a file in the server folder');
      server[key] = value;
    }
    if (server.isProxy && 'port' in patch) store.db.network.proxyPort = server.port;
    store.save();
    this.emit('changed');
    require('./network').syncBackends().catch(() => {});
    return server;
  }

  async remove(id, { deleteBackups = true } = {}) {
    this.get(id);
    if (this.isRunning(id)) await this.stop(id);
    store.db.servers = store.db.servers.filter((s) => s.id !== id);
    if (store.db.network.lobby === id) store.db.network.lobby = null;
    store.save();
    this.runtime.delete(id);
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    if (deleteBackups) fs.rmSync(path.join(paths.backups, id), { recursive: true, force: true });
    this.emit('changed');
    require('./network').onServersChanged().catch(() => {});
  }

  async pollPlayers(server) {
    const r = this.rt(server.id);
    if (r.status !== 'running') return;
    try {
      r.players = await slp.ping('127.0.0.1', server.port, 2500);
    } catch {
      // Servers bound to a specific public IP won't answer on loopback; that's fine.
    }
  }

  startStatsLoop() {
    let tick = 0;
    this.statsTimer = setInterval(() => {
      tick++;
      const snapshot = {};
      for (const server of store.db.servers) {
        const r = this.rt(server.id);
        if (!r.child) continue;
        r.stats = procstats.usage(r.child.pid);
        if (tick % 4 === 0) this.pollPlayers(server);
        snapshot[server.id] = { stats: r.stats, players: r.players, startedAt: r.startedAt };
      }
      this.emit('stats', snapshot);
    }, 2500);
  }

  async autostart() {
    const list = store.db.servers.filter(
      (s) => s.autostart && s.installState === 'installed' && (!s.isProxy || store.db.network.enabled),
    );
    // Backends first so the proxy can reach them when it comes up.
    for (const s of list.sort((a, b) => Number(a.isProxy) - Number(b.isProxy))) {
      try {
        await this.start(s.id);
      } catch (err) {
        this.log(s.id, `Autostart failed: ${err.message}`);
      }
    }
  }

  async stopAll() {
    const running = store.db.servers.filter((s) => this.isRunning(s.id));
    await Promise.all(running.map((s) => this.stop(s.id)));
  }
}

module.exports = new ServerManager();
module.exports.slugify = slugify;
module.exports.httpError = httpError;
