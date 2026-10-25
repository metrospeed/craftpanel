const express = require('express');
const fs = require('fs');
const path = require('path');
const servers = require('../servers');
const providers = require('../providers');
const props = require('../util/properties');
const worlds = require('../worlds');
const datapacks = require('../datapacks');
const { requireAdmin, requireServerAccess, canAccess } = require('../auth');
const { ah, folderUpload } = require('./util');

const router = express.Router();

// Fields any user with access may change; the rest (Java path, JVM flags,
// ports, memory...) can run arbitrary code or affect the host, so admin only.
const USER_FIELDS = ['autostart', 'autoRestart', 'backup', 'restartAt'];

router.get('/types', (req, res) => res.json(providers.list()));

router.get(
  '/types/:type/versions',
  ah(async (req, res) => {
    res.json(await providers.get(req.params.type).versions({ snapshots: req.query.snapshots === '1' }));
  }),
);

router.get(
  '/types/:type/loaders/:mc',
  ah(async (req, res) => {
    const p = providers.get(req.params.type);
    res.json(p.loaderVersions ? await p.loaderVersions(req.params.mc) : []);
  }),
);

router.get('/servers', (req, res) => {
  res.json(servers.all().filter((s) => canAccess(req.user, s.id)).map((s) => servers.view(s)));
});

// JSON, or multipart with the settings as a JSON `data` field plus an
// existing world in `files` (one archive, or the files of a folder).
router.post(
  '/servers',
  requireAdmin,
  folderUpload.array('files'),
  ah(async (req, res) => {
    const files = req.files || [];
    let world = null;
    try {
      const b = req.is('multipart/form-data') ? JSON.parse(req.body?.data || '{}') : req.body || {};
      if (files.length) world = await worlds.prepare(files);
      const server = await servers.create({
        name: b.name,
        type: b.type,
        mcVersion: b.mcVersion,
        loaderVersion: b.loaderVersion,
        memoryMb: b.memoryMb,
        port: b.port,
        network: b.network,
        autostart: b.autostart,
        eula: b.eula,
        world,
      });
      res.status(201).json(servers.view(server));
    } finally {
      worlds.cleanup(world);
      for (const f of files) fs.rmSync(f.path, { force: true });
    }
  }),
);

const byId = express.Router({ mergeParams: true });
router.use('/servers/:id', requireServerAccess, byId);

byId.get('/', (req, res) => res.json(servers.view(servers.get(req.params.id))));

byId.patch('/', (req, res) => {
  const patch = { ...(req.body || {}) };
  if (!req.user.admin) for (const k of Object.keys(patch)) if (!USER_FIELDS.includes(k)) delete patch[k];
  res.json(servers.view(servers.update(req.params.id, patch)));
});

byId.delete(
  '/',
  requireAdmin,
  ah(async (req, res) => {
    await servers.remove(req.params.id, { deleteBackups: req.query.keepBackups !== '1' });
    res.json({ ok: true });
  }),
);

byId.post(
  '/start',
  ah(async (req, res) => {
    await servers.start(req.params.id);
    res.json({ ok: true });
  }),
);

byId.post('/stop', (req, res) => {
  servers.stop(req.params.id);
  res.json({ ok: true });
});

byId.post('/restart', (req, res) => {
  servers.restart(req.params.id).catch((e) => servers.log(req.params.id, `Restart failed: ${e.message}`));
  res.json({ ok: true });
});

byId.post('/kill', (req, res) => {
  servers.kill(req.params.id);
  res.json({ ok: true });
});

byId.post('/command', (req, res) => {
  servers.command(req.params.id, req.body?.command);
  res.json({ ok: true });
});

// Datapack compatibility check (run by the UI before Start) and fixes.
byId.get(
  '/datapacks',
  ah(async (req, res) => {
    const server = servers.get(req.params.id);
    res.json(await datapacks.check(server, { failed: servers.rt(server.id).issue?.packs || [] }));
  }),
);

byId.post('/datapacks/disable', (req, res) => {
  res.json(datapacks.disable(servers.get(req.params.id), req.body?.name));
});

byId.post(
  '/datapacks/update',
  ah(async (req, res) => {
    res.json(await datapacks.update(servers.get(req.params.id), req.body?.name, req.body?.versionId));
  }),
);

byId.get('/logs', (req, res) => res.json(servers.rt(req.params.id).logs));

// Reinstall, optionally switching Minecraft / loader version.
byId.post(
  '/reinstall',
  requireAdmin,
  ah(async (req, res) => {
    const server = servers.get(req.params.id);
    if (servers.isRunning(server.id)) throw servers.httpError(409, 'Stop the server first');
    if (req.body?.mcVersion) server.mcVersion = String(req.body.mcVersion);
    if ('loaderVersion' in (req.body || {})) server.loaderVersion = req.body.loaderVersion || null;
    servers.install(server.id).catch(() => {});
    res.json({ ok: true });
  }),
);

byId.get('/properties', (req, res) => {
  res.json(props.read(path.join(servers.dir(req.params.id), 'server.properties')));
});

byId.put('/properties', (req, res) => {
  const server = servers.get(req.params.id);
  const changes = { ...(req.body || {}) };
  // Port and binding are managed by the panel (network automation).
  delete changes['server-port'];
  if (server.networkManaged) {
    delete changes['server-ip'];
    delete changes['online-mode'];
  }
  props.update(path.join(servers.dir(server.id), 'server.properties'), changes);
  res.json({ ok: true });
});

module.exports = router;
