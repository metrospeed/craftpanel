const path = require('path');
const fs = require('fs');
const pkg = require('../package.json');

const DATA_DIR = path.resolve(process.env.CP_DATA_DIR || path.join(__dirname, '..', 'data'));

const paths = {
  data: DATA_DIR,
  db: path.join(DATA_DIR, 'db.json'),
  servers: path.join(DATA_DIR, 'servers'),
  backups: path.join(DATA_DIR, 'backups'),
  java: path.join(DATA_DIR, 'java'),
  cache: path.join(DATA_DIR, 'cache'),
  tmp: path.join(DATA_DIR, 'tmp'),
  public: path.join(__dirname, '..', 'public'),
};

for (const key of ['data', 'servers', 'backups', 'java', 'cache', 'tmp']) {
  fs.mkdirSync(paths[key], { recursive: true });
}

module.exports = {
  version: pkg.version,
  paths,
  host: process.env.CP_HOST || '0.0.0.0',
  port: Number(process.env.CP_PORT) || 8080,
  userAgent: `CraftPanel/${pkg.version} (self-hosted Minecraft server panel)`,
  isLinux: process.platform === 'linux',
};
