const express = require('express');
const fs = require('fs');
const path = require('path');
const servers = require('../servers');
const content = require('../content');
const { requireServerAccess } = require('../auth');
const { ah, upload } = require('./util');

const router = express.Router({ mergeParams: true });
router.use(requireServerAccess);

const server = (req) => servers.get(req.params.id);

router.get('/', ah(async (req, res) => res.json(await content.listFiles(server(req)))));

router.get(
  '/search',
  ah(async (req, res) => {
    res.json(await content.search(server(req), { query: req.query.query, offset: req.query.offset, sort: req.query.sort }));
  }),
);

router.get(
  '/project/:pid/versions',
  ah(async (req, res) => {
    const versions = await content.versionsFor(server(req), req.params.pid);
    res.json(versions.slice(0, 30).map((v) => ({ id: v.id, name: v.name, number: v.version_number, type: v.version_type, date: v.date_published })));
  }),
);

router.post(
  '/install',
  ah(async (req, res) => {
    const s = server(req);
    const files = await content.install(s, req.body?.projectId, {
      versionId: req.body?.versionId,
      log: (l) => servers.log(s.id, l),
    });
    res.json({ ok: true, files, restartNeeded: servers.isRunning(s.id) });
  }),
);

router.get('/updates', ah(async (req, res) => res.json(await content.checkUpdates(server(req)))));

router.post(
  '/update',
  ah(async (req, res) => {
    const s = server(req);
    const updates = await content.checkUpdates(s);
    const targets = req.body?.file ? [req.body.file] : Object.keys(updates);
    const files = (await content.listFiles(s)).filter((f) => targets.includes(f.file) && updates[f.file]);
    for (const f of files) {
      await content.install(s, f.projectId, { versionId: updates[f.file].versionId, log: (l) => servers.log(s.id, l) });
    }
    res.json({ ok: true, updated: files.length });
  }),
);

router.post('/toggle', (req, res) => res.json({ file: content.toggle(server(req), req.body?.file) }));

router.post('/delete', (req, res) => {
  content.remove(server(req), req.body?.file);
  res.json({ ok: true });
});

router.post('/upload', upload.array('files'), (req, res) => {
  const { folder } = content.info(server(req));
  fs.mkdirSync(folder, { recursive: true });
  for (const f of req.files || []) {
    const name = path.basename(f.originalname);
    if (!name.toLowerCase().endsWith('.jar')) {
      fs.rmSync(f.path, { force: true });
      continue;
    }
    fs.copyFileSync(f.path, path.join(folder, name));
    fs.rmSync(f.path, { force: true });
  }
  res.json({ ok: true });
});

module.exports = router;
