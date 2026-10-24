const http = require('../util/http');
const { downloadTo } = require('./common');

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

module.exports = {
  id: 'vanilla',
  name: 'Vanilla',
  description: 'The official Mojang server. No plugins or mods, and cannot join the proxy network.',
  content: null,
  network: false,
  async versions({ snapshots } = {}) {
    const data = await http.cachedJson(MANIFEST);
    return data.versions
      .filter((v) => v.type === 'release' || (snapshots && v.type === 'snapshot'))
      .map((v) => ({ id: v.id, stable: v.type === 'release' }));
  },
  async install({ dir, mcVersion, log }) {
    const manifest = await http.cachedJson(MANIFEST);
    const entry = manifest.versions.find((v) => v.id === mcVersion);
    if (!entry) throw new Error(`Unknown Minecraft version ${mcVersion}`);
    const meta = await http.getJson(entry.url);
    const server = meta.downloads?.server;
    if (!server) throw new Error(`Mojang does not publish a server jar for ${mcVersion}`);
    await downloadTo(server.url, dir, 'server.jar', log, { sha1: server.sha1 });
    return { launch: { jar: 'server.jar' } };
  },
};
