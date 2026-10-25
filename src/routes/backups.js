const express = require('express');
const path = require('path');
const store = require('../store');
const servers = require('../servers');
const backups = require('../backups');
const { requireServerAccess } = require('../auth');
const { ah } = require('./util');

const router = express.Router({ mergeParams: true });
router.use(requireServerAccess);

router.get('/', (req, res) => {
  const s = servers.get(req.params.id);
  const root = store.db.settings.backupCopy?.path || '';
  const list = backups.list(s.id);
  res.json({
    backups: list,
    busy: backups.isBusy(s.id),
    schedule: s.backup,
    copy: root ? { path: path.join(root, s.id), problem: backups.copyProblem() || list.copyError || null } : null,
  });
});

router.post('/', (req, res) => {
  const s = servers.get(req.params.id);
  if (backups.isBusy(s.id)) throw servers.httpError(409, 'A backup is already running');
  // Large servers take a while; respond now and report progress in the console.
  backups.create(s.id, { label: req.body?.label }).catch(() => {});
  res.status(202).json({ ok: true });
});

router.post(
  '/:name/restore',
  ah(async (req, res) => {
    await backups.restore(req.params.id, req.params.name);
    res.json({ ok: true });
  }),
);

router.get('/:name/download', (req, res) => res.download(backups.resolve(req.params.id, req.params.name)));

router.delete('/:name', (req, res) => {
  backups.remove(req.params.id, req.params.name);
  res.json({ ok: true });
});

module.exports = router;
