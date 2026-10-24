// Paper, Folia and Velocity all come from the PaperMC "Fill" download API.
const http = require('../util/http');
const { downloadTo } = require('./common');

const API = 'https://fill.papermc.io/v3/projects';

function papermc(project, meta) {
  return {
    ...meta,
    async versions() {
      const data = await http.cachedJson(`${API}/${project}`);
      const out = [];
      for (const group of Object.values(data.versions)) {
        for (const id of group) out.push({ id, stable: !/(snapshot|pre|rc|alpha|beta)/i.test(id) });
      }
      return out;
    },
    async install({ dir, mcVersion, log }) {
      const build = await http.getJson(`${API}/${project}/versions/${encodeURIComponent(mcVersion)}/builds/latest`);
      const dl = build.downloads?.['server:default'];
      if (!dl) throw new Error(`No downloadable ${meta.name} build for ${mcVersion}`);
      const jar = project === 'velocity' ? 'velocity.jar' : 'server.jar';
      log(`${meta.name} ${mcVersion} build #${build.id} (${build.channel})`);
      await downloadTo(dl.url, dir, jar, log, { sha256: dl.checksums?.sha256 });
      return { launch: { jar }, build: String(build.id) };
    },
  };
}

module.exports = {
  paper: papermc('paper', {
    id: 'paper',
    name: 'Paper',
    description: 'High-performance Spigot fork. Best choice for plugin servers.',
    content: 'plugins',
    network: true,
  }),
  folia: papermc('folia', {
    id: 'folia',
    name: 'Folia',
    description: 'Multithreaded Paper fork for very large player counts. Only Folia-compatible plugins work.',
    content: 'plugins',
    network: true,
  }),
  velocity: papermc('velocity', {
    id: 'velocity',
    name: 'Velocity',
    description: 'Proxy that links all your servers behind one address.',
    content: 'plugins',
    proxy: true,
  }),
};
