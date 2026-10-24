const http = require('../util/http');
const { downloadTo } = require('./common');

const API = 'https://api.purpurmc.org/v2/purpur';

module.exports = {
  id: 'purpur',
  name: 'Purpur',
  description: 'Paper fork with hundreds of extra gameplay options. Runs Paper plugins.',
  content: 'plugins',
  network: true,
  async versions() {
    const data = await http.cachedJson(API);
    return [...data.versions].reverse().map((id) => ({ id, stable: true }));
  },
  async install({ dir, mcVersion, log }) {
    const info = await http.getJson(`${API}/${encodeURIComponent(mcVersion)}/latest`);
    log(`Purpur ${mcVersion} build #${info.build}`);
    await downloadTo(`${API}/${encodeURIComponent(mcVersion)}/latest/download`, dir, 'server.jar', log);
    return { launch: { jar: 'server.jar' }, build: String(info.build) };
  },
};
