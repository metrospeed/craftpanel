const crypto = require('crypto');
const store = require('./store');

const COOKIE = 'cp_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const attempts = new Map();

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const tokenKey = (token) => crypto.createHash('sha256').update(token).digest('hex');

function publicUser(u) {
  return u && { id: u.id, username: u.username, admin: !!u.admin, servers: u.servers || [] };
}

function validateCredentials(username, password) {
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(String(username || ''))) {
    throw Object.assign(new Error('Username must be 3-32 letters, numbers, dots, dashes or underscores'), { status: 400 });
  }
  if (String(password || '').length < 8) {
    throw Object.assign(new Error('Password must be at least 8 characters'), { status: 400 });
  }
}

function createUser({ username, password, admin = false, servers = [] }) {
  validateCredentials(username, password);
  if (store.db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    throw Object.assign(new Error('That username is taken'), { status: 400 });
  }
  const user = {
    id: crypto.randomUUID(),
    username,
    password: hashPassword(password),
    admin: !!admin,
    servers,
    createdAt: new Date().toISOString(),
  };
  store.db.users.push(user);
  store.save();
  return user;
}

function login(username, password, ip) {
  const key = `${ip}:${String(username).toLowerCase()}`;
  const rec = attempts.get(key) || { count: 0, until: 0 };
  if (rec.until > Date.now()) {
    throw Object.assign(new Error('Too many attempts. Try again in a few minutes.'), { status: 429 });
  }
  const user = store.db.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase());
  if (!user || !verifyPassword(password, user.password)) {
    rec.count++;
    if (rec.count >= 5) {
      rec.until = Date.now() + 5 * 60 * 1000;
      rec.count = 0;
    }
    attempts.set(key, rec);
    throw Object.assign(new Error('Invalid username or password'), { status: 401 });
  }
  attempts.delete(key);
  const token = crypto.randomBytes(32).toString('base64url');
  store.db.sessions[tokenKey(token)] = { userId: user.id, expires: Date.now() + SESSION_TTL_MS };
  store.save();
  return { token, user };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const session = store.db.sessions[tokenKey(token)];
  if (!session || session.expires < Date.now()) return null;
  return store.db.users.find((u) => u.id === session.userId) || null;
}

function logout(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    delete store.db.sessions[tokenKey(token)];
    store.save();
  }
}

function purgeSessions(userId) {
  for (const [k, s] of Object.entries(store.db.sessions)) {
    if (s.userId === userId || s.expires < Date.now()) delete store.db.sessions[k];
  }
  store.save();
}

function setCookie(res, token, secure) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_TTL_MS / 1000}`];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Middleware ---------------------------------------------------------------

function requireAuth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  // CSRF defence: state-changing requests must come from our own frontend.
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('X-CP-Request') !== '1') {
    return res.status(403).json({ error: 'Missing request header' });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user?.admin) return res.status(403).json({ error: 'Administrator access required' });
  next();
}

function canAccess(user, serverId) {
  return !!user && (user.admin || (user.servers || []).includes(serverId));
}

function requireServerAccess(req, res, next) {
  if (!canAccess(req.user, req.params.id)) return res.status(403).json({ error: 'You do not have access to this server' });
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  createUser,
  validateCredentials,
  login,
  logout,
  purgeSessions,
  userFromRequest,
  publicUser,
  setCookie,
  clearCookie,
  requireAuth,
  requireAdmin,
  requireServerAccess,
  canAccess,
};
