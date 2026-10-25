// Importing an existing world (singleplayer save or another server's world)
// when a server is created. Uploads are unpacked into a temp folder, checked
// for a level.dat, then moved into the server folder as `world`.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tar = require('tar');
const { paths } = require('./config');
const { safeJoin } = require('./util/fsutil');
const unzip = require('./util/unzip');

// Paper, Purpur and Folia keep the Nether and End in world_nether / world_the_end.
const SPLIT_DIMENSIONS = new Set(['paper', 'purpur', 'folia']);
const DIMENSIONS = [
  ['_nether', 'DIM-1'],
  ['_the_end', 'DIM1'],
];
const MAX_DEPTH = 4;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

const hasLevelDat = (dir) => fs.existsSync(path.join(dir, 'level.dat'));

/** Every folder (up to MAX_DEPTH deep) that contains a level.dat, shallowest first. */
function findWorlds(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (hasLevelDat(dir)) found.push({ dir, depth });
    if (depth >= MAX_DEPTH) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('__MACOSX')) walk(path.join(dir, e.name), depth + 1);
    }
  };
  walk(root, 0);
  return found.sort((a, b) => a.depth - b.depth);
}

const isDimensionFolder = (name) => DIMENSIONS.some(([suffix]) => name.endsWith(suffix));

/**
 * Unpack the uploaded files into a temp folder and locate the world in them.
 * `files` are multer files: one .zip/.tar.gz/.tar archive, or the contents of
 * a folder with their relative paths as `originalname`.
 */
async function prepare(files) {
  const tmp = path.join(paths.tmp, `world-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const archive = files.length === 1 && /\.(zip|tar\.gz|tgz|tar)$/i.test(files[0].originalname) ? files[0] : null;
    if (archive && /\.zip$/i.test(archive.originalname)) {
      try {
        unzip.extract(archive.path, tmp);
      } catch (err) {
        throw badRequest(`Could not read the zip file: ${err.message}`);
      }
    } else if (archive) {
      await tar
        .x({
          file: archive.path,
          cwd: tmp,
          // Plain files and folders only: no links that could point outside the server folder.
          filter: (p, entry) => (entry.type === 'File' || entry.type === 'Directory') && !p.split('/').includes('..'),
        })
        .catch((err) => {
          throw badRequest(`Could not read the archive: ${err.message}`);
        });
    } else {
      for (const f of files) {
        const target = safeJoin(tmp, f.originalname);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(f.path, target);
      }
    }

    const worlds = findWorlds(tmp).filter((w) => w.dir === tmp || !isDimensionFolder(path.basename(w.dir)));
    const shallowest = worlds.filter((w) => w.depth === worlds[0]?.depth);
    const main = shallowest.find((w) => path.basename(w.dir) === 'world') || shallowest[0];
    if (!main) {
      throw badRequest('No world found in the upload. It must contain a world folder with a level.dat file in it.');
    }
    // Bukkit-style servers store the other dimensions next to the main world.
    const siblings = {};
    for (const [suffix] of DIMENSIONS) {
      const dir = main.dir + suffix;
      if (main.dir !== tmp && hasLevelDat(dir)) siblings[suffix] = dir;
    }
    return { tmp, main: main.dir, siblings };
  } catch (err) {
    cleanup({ tmp });
    throw err;
  }
}

/** Move a prepared world into `serverDir` as `world` (plus world_nether / world_the_end where the server type uses them). */
function place(world, serverDir, type) {
  const target = path.join(serverDir, 'world');
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(world.main, target);
  for (const [suffix, dim] of DIMENSIONS) {
    const src = world.siblings[suffix];
    if (!src) continue;
    if (SPLIT_DIMENSIONS.has(type)) {
      const dest = target + suffix;
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(src, dest);
    } else if (fs.existsSync(path.join(src, dim)) && !fs.existsSync(path.join(target, dim))) {
      // Vanilla-style servers keep every dimension inside the main world folder.
      fs.renameSync(path.join(src, dim), path.join(target, dim));
    }
  }
  // A lock left behind by the game that saved the world would stop the server loading it.
  for (const dir of [target, target + '_nether', target + '_the_end']) {
    fs.rmSync(path.join(dir, 'session.lock'), { force: true });
  }
}

function cleanup(world) {
  if (world?.tmp) fs.rmSync(world.tmp, { recursive: true, force: true });
}

module.exports = { prepare, place, cleanup };
