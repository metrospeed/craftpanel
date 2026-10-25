// Network, users, panel settings and system info.
const express = require('express');
const store = require('../store');
const config = require('../config');
const network = require('../network');
const java = require('../java');
const updater = require('../updater');
const servers = require('../servers');
const procstats = require('../util/procstats');
const { dirSize } = require('../util/fsutil');
const auth = require('../auth');
const { ah } = require('./util');

const router = express.Router();
const { requireAdmin } = auth;

// Account ------------------------------------------------------------------

router.post('/account/password', (req, res) => {
  const { current, next } = req.body || {};
  if (!auth.verifyPassword(current, req.user.password)) throw servers.httpError(400, 'Current password is incorrect');
  auth.validateCredentials(req.user.username, next);
  req.user.password = auth.hashPassword(next);
  store.save();
  res.json({ ok: true });
});

// Network ------------------------------------------------------------------

router.get('/network', requireAdmin, (req, res) => res.json(network.status()));
router.put('/network', requireAdmin, (req, res) => res.json(network.update(req.body || {})));
router.post('/network/enable', requireAdmin, ah(async (req, res) => res.json(await network.enable(req.body || {}))));
router.post('/network/disable', requireAdmin, ah(async (req, res) => res.json(await network.disable())));

// Users --------------------------------------------------------------------

router.get('/users', requireAdmin, (req, res) => res.json(store.db.users.map(auth.publicUser)));

router.post('/users', requireAdmin, (req, res) => {
  const { username, password, admin, servers: list } = req.body || {};
  res.status(201).json(auth.publicUser(auth.createUser({ username, password, admin, servers: Array.isArray(list) ? list : [] })));
});

router.patch('/users/:uid', requireAdmin, (req, res) => {
  const user = store.db.users.find((u) => u.id === req.params.uid);
  if (!user) throw servers.httpError(404, 'User not found');
  const b = req.body || {};
  if ('admin' in b) {
    if (!b.admin && user.admin && store.db.users.filter((u) => u.admin).length === 1) {
      throw servers.httpError(400, 'There must be at least one administrator');
    }
    user.admin = !!b.admin;
  }
  if (Array.isArray(b.servers)) user.servers = b.servers.map(String);
  if (b.password) {
    auth.validateCredentials(user.username, b.password);
    user.password = auth.hashPassword(b.password);
    auth.purgeSessions(user.id);
  }
  store.save();
  res.json(auth.publicUser(user));
});

router.delete('/users/:uid', requireAdmin, (req, res) => {
  if (req.params.uid === req.user.id) throw servers.httpError(400, 'You cannot delete your own account');
  store.db.users = store.db.users.filter((u) => u.id !== req.params.uid);
  auth.purgeSessions(req.params.uid);
  res.json({ ok: true });
});

// System -------------------------------------------------------------------

router.get(
  '/system',
  ah(async (req, res) => {
    const out = { version: config.version, system: procstats.system(), settings: store.db.settings };
    if (req.user.admin) {
      out.java = await java.listRuntimes();
      out.dataDir = config.paths.data;
      out.diskUsage = { servers: dirSize(config.paths.servers), backups: dirSize(config.paths.backups) };
    }
    res.json(out);
  }),
);

router.put('/settings', requireAdmin, (req, res) => {
  const b = req.body || {};
  if ('javaMode' in b) {
    if (!['auto', 'system'].includes(b.javaMode)) throw servers.httpError(400, 'javaMode must be auto or system');
    store.db.settings.javaMode = b.javaMode;
  }
  if ('basePort' in b) {
    const p = Number(b.basePort);
    if (!Number.isInteger(p) || p < 1024 || p > 65000) throw servers.httpError(400, 'Invalid base port');
    store.db.settings.basePort = p;
  }
  store.save();
  res.json(store.db.settings);
});

// Updates ------------------------------------------------------------------

router.get('/update', requireAdmin, ah(async (req, res) => res.json(await updater.check({ force: req.query.force === '1' }))));
router.post('/update', requireAdmin, (req, res) => res.json(updater.requestUpdate(servers)));

router.delete('/java/:major', requireAdmin, (req, res) => {
  java.removeRuntime(req.params.major);
  res.json({ ok: true });
});

module.exports = router;
