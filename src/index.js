const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const config = require('./config');
const store = require('./store');
const auth = require('./auth');
const servers = require('./servers');
const backups = require('./backups');

store.load();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// Public auth endpoints -----------------------------------------------------

const csrf = (req, res, next) =>
  req.get('X-CP-Request') === '1' ? next() : res.status(403).json({ error: 'Missing request header' });

app.get('/api/auth/state', (req, res) => {
  res.json({
    setupRequired: store.db.users.length === 0,
    user: auth.publicUser(auth.userFromRequest(req)),
    version: config.version,
    build: require('./updater').installedCommit()?.slice(0, 7) || null,
  });
});

app.post('/api/auth/setup', csrf, (req, res) => {
  if (store.db.users.length) return res.status(400).json({ error: 'Setup has already been completed' });
  const { username, password } = req.body || {};
  auth.createUser({ username, password, admin: true });
  const { token, user } = auth.login(username, password, req.ip);
  auth.setCookie(res, token, req.secure);
  res.json({ user: auth.publicUser(user) });
});

app.post('/api/auth/login', csrf, (req, res) => {
  const { username, password } = req.body || {};
  const { token, user } = auth.login(username, password, req.ip);
  auth.setCookie(res, token, req.secure);
  res.json({ user: auth.publicUser(user) });
});

app.post('/api/auth/logout', csrf, (req, res) => {
  auth.logout(req);
  auth.clearCookie(res);
  res.json({ ok: true });
});

// Authenticated API ---------------------------------------------------------

app.use('/api', auth.requireAuth);
app.use('/api', require('./routes/servers'));
app.use('/api/servers/:id/files', require('./routes/files'));
app.use('/api/servers/:id/content', require('./routes/content'));
app.use('/api/servers/:id/backups', require('./routes/backups'));
app.use('/api', require('./routes/admin'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// No max-age: the browser revalidates via ETag so panel upgrades take effect immediately.
app.use(express.static(config.paths.public, { index: 'index.html' }));
app.get('*', (req, res) => res.sendFile('index.html', { root: config.paths.public }));

app.use((err, req, res, _next) => {
  const status = err.status || (err.code === 'ENOENT' ? 404 : err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.code === 'ENOENT' ? 'File not found' : err.message || 'Internal error' });
});

// WebSocket: console output, status changes and live stats -------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
  // Browsers always send Origin on WebSocket handshakes; refuse other sites.
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return socket.destroy();
  const user = auth.userFromRequest(req);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = user;
    ws.subscriptions = new Set();
    wss.emit('connection', ws);
  });
});

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'subscribe' && auth.canAccess(ws.user, msg.server)) {
      ws.subscriptions.add(msg.server);
      ws.send(JSON.stringify({ type: 'history', server: msg.server, lines: servers.rt(msg.server).logs }));
    } else if (msg.type === 'unsubscribe') {
      ws.subscriptions.delete(msg.server);
    }
  });
});

function broadcast(payload, filter) {
  const data = JSON.stringify(payload);
  for (const ws of wss.clients) {
    if (ws.readyState === 1 && (!filter || filter(ws))) ws.send(data);
  }
}

servers.on('log', (id, line) => broadcast({ type: 'log', server: id, line }, (ws) => ws.subscriptions.has(id)));
servers.on('status', (id, status) => broadcast({ type: 'status', server: id, status }, (ws) => auth.canAccess(ws.user, id)));
servers.on('changed', () => broadcast({ type: 'changed' }));
servers.on('stats', (snapshot) => {
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    const visible = Object.fromEntries(Object.entries(snapshot).filter(([id]) => auth.canAccess(ws.user, id)));
    ws.send(JSON.stringify({ type: 'stats', data: visible }));
  }
});

// Startup / shutdown -----------------------------------------------------------

// Any server that was mid-install when the panel died needs reinstalling.
for (const s of store.db.servers) {
  if (s.installState === 'installing') {
    s.installState = 'failed';
    s.installError = 'Panel restarted during installation';
  }
}
store.save();

server.listen(config.port, config.host, () => {
  console.log(`CraftPanel ${config.version} listening on http://${config.host}:${config.port}`);
  console.log(`Data directory: ${config.paths.data}`);
  if (!store.db.users.length) console.log('Open the panel in your browser to create the admin account.');
  servers.startStatsLoop();
  backups.startScheduler();
  // Autostart applies network settings per server; sync the rest (stopped ones, proxy list) afterwards.
  const updater = require('./updater');
  const resume = updater.takeResumeList();
  servers
    .autostart()
    .then(async () => {
      // Bring back servers that were running before a one-click update.
      for (const id of resume) {
        if (servers.find(id) && !servers.isRunning(id)) await servers.start(id).catch((e) => servers.log(id, `Restart after update failed: ${e.message}`));
      }
      await require('./network').syncBackends();
    })
    .catch((e) => console.error(e));
  updater.startBackgroundChecks();
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, stopping all servers...`);
  try {
    await servers.stopAll();
  } finally {
    store.saveNow();
    process.exit(0);
  }
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
