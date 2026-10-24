const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { userAgent } = require('../config');

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'User-Agent': userAgent, ...headers },
    body,
    redirect: 'follow',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`HTTP ${res.status} from ${new URL(url).host}${text ? ': ' + text.slice(0, 200) : ''}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function getJson(url, opts) {
  return (await request(url, opts)).json();
}

async function postJson(url, payload) {
  return getJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

const cache = new Map();

// GET JSON with an in-memory TTL cache; version lists change rarely.
async function cachedJson(url, ttlMs = 10 * 60 * 1000) {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = await getJson(url);
  cache.set(url, { value, expires: Date.now() + ttlMs });
  return value;
}

/**
 * Stream a URL to disk. Writes to `<dest>.part` and renames on success so a
 * failed download never leaves a truncated jar behind.
 */
async function download(url, dest, { onProgress, sha256, sha1 } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await request(url);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = sha256 ? crypto.createHash('sha256') : sha1 ? crypto.createHash('sha1') : null;
  let received = 0;
  let lastReport = 0;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (hash) hash.update(chunk);
      if (onProgress && Date.now() - lastReport > 1000) {
        lastReport = Date.now();
        onProgress(received, total);
      }
      cb(null, chunk);
    },
  });
  const part = dest + '.part';
  await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(part));
  if (hash) {
    const digest = hash.digest('hex');
    const expected = (sha256 || sha1).toLowerCase();
    if (digest !== expected) {
      fs.rmSync(part, { force: true });
      throw new Error(`Checksum mismatch for ${path.basename(dest)}`);
    }
  }
  fs.renameSync(part, dest);
  if (onProgress) onProgress(received, total || received);
  return dest;
}

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

module.exports = { request, getJson, postJson, cachedJson, download, formatBytes };
