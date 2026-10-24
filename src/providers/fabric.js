const http = require('../util/http');
const { downloadTo } = require('./common');

const META = 'https://meta.fabricmc.net/v2';

module.exports = {
  id: 'fabric',
  name: 'Fabric',
  description: 'Lightweight mod loader. Huge library of performance and gameplay mods.',
  content: 'mods',
  network: true,
  hasLoader: true,
  async versions({ snapshots } = {}) {
    const games = await http.cachedJson(`${META}/versions/game`);
    return games.filter((g) => g.stable || snapshots).map((g) => ({ id: g.version, stable: g.stable }));
  },
  async loaderVersions() {
    const loaders = await http.cachedJson(`${META}/versions/loader`);
    return loaders.map((l) => ({ id: l.version, label: l.version, stable: l.stable }));
  },
  async install({ dir, mcVersion, loaderVersion, log }) {
    const loader = loaderVersion || (await this.loaderVersions()).find((l) => l.stable).id;
    const installers = await http.cachedJson(`${META}/versions/installer`);
    const installer = (installers.find((i) => i.stable) || installers[0]).version;
    log(`Fabric loader ${loader} for Minecraft ${mcVersion} (installer ${installer})`);
    const url = `${META}/versions/loader/${encodeURIComponent(mcVersion)}/${loader}/${installer}/server/jar`;
    await downloadTo(url, dir, 'server.jar', log);
    log('The Fabric launcher downloads the vanilla server files on its first start.');
    return { launch: { jar: 'server.jar' }, loaderVersion: loader };
  },
};
