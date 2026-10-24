const express = require('express');
const servers = require('../servers');
const backups = require('../backups');
const { requireServerAccess } = require('../auth');
const { ah } = require('./util');

const router = express.Router({ mergeParams: true });
router.use(requireServerAccess);

router.get('/', (req, res) => {
  const s = servers.get(req.params.id);
  res.json({ backups: backups.list(s.id), busy: backups.isBusy(s.id), schedule: s.backup });
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
