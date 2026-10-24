// Forge and NeoForge both ship an installer jar that is run with --installServer.
const fs = require('fs');
const path = require('path');
const http = require('../util/http');
const { cmpVersion, isStable, downloadTo, run } = require('./common');

const argsFileName = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';

async function runInstaller({ dir, url, file, java, log }) {
  await downloadTo(url, dir, file, log);
  log('Running installer (this can take a few minutes)...');
  await run(java, ['-jar', file, '--installServer'], { cwd: dir, log });
  fs.rmSync(path.join(dir, file), { force: true });
  fs.rmSync(path.join(dir, file + '.log'), { force: true });
}

const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const FORGE_META = 'https://files.minecraftforge.net/net/minecraftforge/forge';

const forge = {
  id: 'forge',
  name: 'Forge',
  description: 'The classic mod loader with the largest catalogue of big content mods.',
  content: 'mods',
  network: true,
  hasLoader: true,
  async versions() {
    const meta = await http.cachedJson(`${FORGE_META}/maven-metadata.json`);
    return Object.keys(meta)
      .filter((mc) => cmpVersion(mc, '1.7.10') >= 0 && !/pre/.test(mc))
      .sort((a, b) => cmpVersion(b, a))
      .map((id) => ({ id, stable: true }));
  },
  async loaderVersions(mc) {
    const [meta, promos] = await Promise.all([
      http.cachedJson(`${FORGE_META}/maven-metadata.json`),
      http.cachedJson(`${FORGE_META}/promotions_slim.json`),
    ]);
    const recommended = promos.promos[`${mc}-recommended`];
    const latest = promos.promos[`${mc}-latest`];
    return (meta[mc] || [])
      .map((full) => {
        const short = full.slice(mc.length + 1).replace(new RegExp(`-${mc.replace(/\./g, '\\.')}$`), '');
        const tag = short === recommended ? ' (recommended)' : short === latest ? ' (latest)' : '';
        return { id: full, label: short + tag, stable: true, recommended: short === recommended };
      })
      .sort((a, b) => cmpVersion(b.id, a.id))
      .sort((a, b) => Number(b.recommended) - Number(a.recommended));
  },
  async install({ dir, mcVersion, loaderVersion, java, log }) {
    const full = loaderVersion || (await this.loaderVersions(mcVersion))[0]?.id;
    if (!full) throw new Error(`No Forge build for ${mcVersion}`);
    log(`Forge ${full}`);
    await runInstaller({
      dir,
      url: `${FORGE_MAVEN}/${full}/forge-${full}-installer.jar`,
      file: 'forge-installer.jar',
      java,
      log,
    });
    const argsFile = `libraries/net/minecraftforge/forge/${full}/${argsFileName}`;
    if (fs.existsSync(path.join(dir, argsFile))) return { launch: { argsFile }, loaderVersion: full };
    const jar = fs.readdirSync(dir).find((f) => /^forge-.*\.jar$/.test(f) && !f.includes('installer'));
    if (!jar) throw new Error('Forge installer finished but no server jar was found');
    return { launch: { jar }, loaderVersion: full };
  },
};

const NEO_API = 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge';
const NEO_MAVEN = 'https://maven.neoforged.net/releases/net/neoforged/neoforge';

// NeoForge versions encode the Minecraft version: 21.1.x -> 1.21.1, 21.0.x -> 1.21, 26.3.0.x -> 26.3
function neoToMc(v) {
  const [a, b, c] = v.split(/[.\-+]/);
  if (Number(a) >= 26) return c && c !== '0' ? `${a}.${b}.${c}` : `${a}.${b}`;
  return b === '0' ? `1.${a}` : `1.${a}.${b}`;
}

async function neoVersions() {
  const data = await http.cachedJson(NEO_API);
  return data.versions.filter((v) => !v.includes('snapshot'));
}

const neoforge = {
  id: 'neoforge',
  name: 'NeoForge',
  description: 'Modern community fork of Forge, used by most new modpacks.',
  content: 'mods',
  network: true,
  hasLoader: true,
  async versions() {
    const all = await neoVersions();
    const byMc = new Map();
    for (const v of all) {
      const mc = neoToMc(v);
      byMc.set(mc, byMc.get(mc) || isStable(v));
    }
    return [...byMc.entries()].sort((a, b) => cmpVersion(b[0], a[0])).map(([id, stable]) => ({ id, stable }));
  },
  async loaderVersions(mc) {
    const all = await neoVersions();
    return all
      .filter((v) => neoToMc(v) === mc)
      .sort((a, b) => cmpVersion(b, a))
      .map((v) => ({ id: v, label: v, stable: isStable(v) }));
  },
  async install({ dir, mcVersion, loaderVersion, java, log }) {
    const list = await this.loaderVersions(mcVersion);
    const v = loaderVersion || (list.find((l) => l.stable) || list[0])?.id;
    if (!v) throw new Error(`No NeoForge build for ${mcVersion}`);
    log(`NeoForge ${v}`);
    await runInstaller({
      dir,
      url: `${NEO_MAVEN}/${v}/neoforge-${v}-installer.jar`,
      file: 'neoforge-installer.jar',
      java,
      log,
    });
    const argsFile = `libraries/net/neoforged/neoforge/${v}/${argsFileName}`;
    if (!fs.existsSync(path.join(dir, argsFile))) throw new Error('NeoForge installer finished but launch arguments were not found');
    return { launch: { argsFile }, loaderVersion: v };
  },
};

module.exports = { forge, neoforge, neoToMc };
