const papermc = require('./papermc');
const purpur = require('./purpur');
const vanilla = require('./vanilla');
const fabric = require('./fabric');
const { forge, neoforge } = require('./forge');

const custom = {
  id: 'custom',
  name: 'Custom JAR',
  description: 'Bring your own server jar. Upload it as server.jar in the Files tab.',
  content: null,
  network: false,
  async versions() {
    return [{ id: 'custom', stable: true }];
  },
  async install({ log }) {
    log('Custom server created. Upload your jar as server.jar using the Files tab, then press Start.');
    return { launch: { jar: 'server.jar' } };
  },
};

const providers = {
  paper: papermc.paper,
  purpur,
  folia: papermc.folia,
  fabric,
  forge,
  neoforge,
  vanilla,
  velocity: papermc.velocity,
  custom,
};

function get(type) {
  const p = providers[type];
  if (!p) {
    const err = new Error(`Unknown server type "${type}"`);
    err.status = 400;
    throw err;
  }
  return p;
}

function list() {
  return Object.values(providers).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    content: p.content,
    network: !!p.network,
    proxy: !!p.proxy,
    hasLoader: !!p.hasLoader,
  }));
}

module.exports = { get, list, providers };
