// Java runtime management. Each Minecraft version needs a particular Java
// major version; in "auto" mode the panel downloads Eclipse Temurin JREs on demand.
const fs = require('fs');
const path = require('path');
const tar = require('tar');
const { execFile } = require('child_process');
const { paths } = require('./config');
const store = require('./store');
const http = require('./util/http');

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const pending = new Map();

function heuristicJava(mc) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(mc || '');
  if (!m) return 21;
  const [a, b, c] = [m[1], m[2], m[3] || 0].map(Number);
  if (a >= 26) return 25;
  if (a === 1) {
    if (b >= 21 || (b === 20 && c >= 5)) return 21;
    if (b >= 17) return 17;
    return 8;
  }
  return 21;
}

function normalize(major) {
  if (major <= 8) return 8;
  if (major <= 11) return 11;
  if (major <= 17) return 17;
  if (major <= 21) return 21;
  return 25;
}

/** The Java major version a given server needs. */
async function requiredJava(type, mcVersion) {
  if (type === 'velocity') {
    const major = Number(String(mcVersion).split('.')[0]);
    return major >= 4 ? 25 : 21;
  }
  try {
    const manifest = await http.cachedJson(MANIFEST, 60 * 60 * 1000);
    const entry = manifest.versions.find((v) => v.id === mcVersion);
    if (entry) {
      const meta = await http.cachedJson(entry.url, 24 * 60 * 60 * 1000);
      if (meta.javaVersion?.majorVersion) return normalize(meta.javaVersion.majorVersion);
    }
  } catch {}
  return heuristicJava(mcVersion);
}

function platformInfo() {
  const os = { linux: 'linux', darwin: 'mac' }[process.platform];
  const arch = { x64: 'x64', arm64: 'aarch64', arm: 'arm' }[process.arch];
  return os && arch ? { os, arch } : null;
}

function runtimeDir(major) {
  return path.join(paths.java, String(major));
}

function findJavaBinary(dir) {
  for (const rel of ['bin/java', 'Contents/Home/bin/java']) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function installRuntime(major, log = () => {}) {
  const plat = platformInfo();
  if (!plat) throw new Error(`Automatic Java download is not supported on ${process.platform}/${process.arch}; switch Java to "system" in Settings.`);
  const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/${plat.os}/${plat.arch}/jre/hotspot/normal/eclipse`;
  const archive = path.join(paths.tmp, `temurin-${major}-${Date.now()}.tar.gz`);
  log(`Downloading Java ${major} runtime (Eclipse Temurin)...`);
  await http.download(url, archive, {
    onProgress: (got, total) => log(`  Java ${major}: ${http.formatBytes(got)}${total ? ' / ' + http.formatBytes(total) : ''}`),
  });
  const dest = runtimeDir(major);
  const staging = dest + '.staging';
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  log(`Extracting Java ${major}...`);
  await tar.x({ file: archive, cwd: staging, strip: 1 });
  fs.rmSync(archive, { force: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(staging, dest);
  const bin = findJavaBinary(dest);
  if (!bin) throw new Error(`Java ${major} archive did not contain bin/java`);
  fs.chmodSync(bin, 0o755);
  log(`Java ${major} installed.`);
  return bin;
}

/** Path to a java executable for the given major version, installing it if needed. */
async function getJava(major, log) {
  if (store.db.settings.javaMode === 'system' || !platformInfo()) return 'java';
  const existing = findJavaBinary(runtimeDir(major));
  if (existing) return existing;
  if (!pending.has(major)) {
    pending.set(major, installRuntime(major, log).finally(() => pending.delete(major)));
  } else if (log) {
    log(`Waiting for Java ${major} download already in progress...`);
  }
  return pending.get(major);
}

function javaVersionOf(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const m = /version "([^"]+)"/.exec(stderr + stdout);
      resolve(m ? m[1] : 'unknown');
    });
  });
}

async function listRuntimes() {
  const out = [];
  for (const name of fs.existsSync(paths.java) ? fs.readdirSync(paths.java) : []) {
    const bin = findJavaBinary(path.join(paths.java, name));
    if (bin) out.push({ major: Number(name), path: bin, version: await javaVersionOf(bin) });
  }
  const system = await javaVersionOf('java');
  return { mode: store.db.settings.javaMode, autoSupported: !!platformInfo(), runtimes: out.sort((a, b) => a.major - b.major), system };
}

function removeRuntime(major) {
  fs.rmSync(runtimeDir(Number(major)), { recursive: true, force: true });
}

module.exports = { requiredJava, getJava, listRuntimes, removeRuntime, heuristicJava };
