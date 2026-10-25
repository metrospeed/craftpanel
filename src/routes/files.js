const express = require('express');
const fs = require('fs');
const path = require('path');
const tar = require('tar');
const servers = require('../servers');
const { safeJoin, isMacJunk } = require('../util/fsutil');
const unzip = require('../util/unzip');
const { requireServerAccess } = require('../auth');
const { ah, upload } = require('./util');

const router = express.Router({ mergeParams: true });
router.use(requireServerAccess);

const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const root = (req) => {
  servers.get(req.params.id);
  return servers.dir(req.params.id);
};
const rel = (base, full) => path.relative(base, full).split(path.sep).join('/');

router.get('/', (req, res) => {
  const base = root(req);
  const dir = safeJoin(base, req.query.path || '');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw servers.httpError(404, 'Folder not found');
  const entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
    let st = null;
    try {
      st = fs.statSync(path.join(dir, e.name));
    } catch {}
    return {
      name: e.name,
      dir: st ? st.isDirectory() : e.isDirectory(),
      size: st && !st.isDirectory() ? st.size : null,
      mtime: st ? st.mtime.toISOString() : null,
    };
  });
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  res.json({ path: rel(base, dir), entries });
});

router.get('/read', (req, res) => {
  const file = safeJoin(root(req), req.query.path);
  const st = fs.statSync(file);
  if (st.isDirectory()) throw servers.httpError(400, 'That is a folder');
  if (st.size > MAX_EDIT_BYTES) throw servers.httpError(413, 'File is too large to edit in the browser; download it instead');
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) throw servers.httpError(415, 'Binary files cannot be edited');
  res.json({ content: buf.toString('utf8') });
});

router.put('/write', (req, res) => {
  const file = safeJoin(root(req), req.body?.path);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(req.body?.content ?? ''));
  res.json({ ok: true });
});

router.post('/upload', upload.array('files'), (req, res) => {
  const dir = safeJoin(root(req), req.query.path || '');
  fs.mkdirSync(dir, { recursive: true });
  let skipped = 0;
  for (const f of req.files || []) {
    if (isMacJunk(f.originalname)) {
      fs.rmSync(f.path, { force: true });
      skipped++;
      continue;
    }
    // Browsers send folder uploads with relative paths in the original name.
    const target = safeJoin(dir, f.originalname);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(f.path, target);
    fs.rmSync(f.path, { force: true });
  }
  res.json({ ok: true, count: (req.files || []).length - skipped, skipped });
});

router.post('/mkdir', (req, res) => {
  fs.mkdirSync(safeJoin(root(req), req.body?.path), { recursive: true });
  res.json({ ok: true });
});

router.post('/rename', (req, res) => {
  const base = root(req);
  const from = safeJoin(base, req.body?.from);
  const to = safeJoin(base, req.body?.to);
  if (from === base) throw servers.httpError(400, 'Cannot rename the server folder');
  if (fs.existsSync(to)) throw servers.httpError(409, 'A file with that name already exists');
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  res.json({ ok: true });
});

router.post('/delete', (req, res) => {
  const base = root(req);
  for (const p of req.body?.paths || []) {
    const target = safeJoin(base, p);
    if (target === base) throw servers.httpError(400, 'Cannot delete the server folder');
    fs.rmSync(target, { recursive: true, force: true });
  }
  res.json({ ok: true });
});

router.post(
  '/extract',
  ah(async (req, res) => {
    const base = root(req);
    const file = safeJoin(base, req.body?.path);
    const dest = path.dirname(file);
    if (/\.zip$/i.test(file)) {
      unzip.extract(file, dest);
    } else if (/\.(tar\.gz|tgz|tar)$/i.test(file)) {
      await tar.x({ file, cwd: dest, filter: (p) => !p.split('/').includes('..') && !isMacJunk(p) });
    } else {
      throw servers.httpError(400, 'Only .zip, .tar.gz and .tar archives can be extracted');
    }
    res.json({ ok: true });
  }),
);

router.get('/download', (req, res) => {
  const base = root(req);
  const target = safeJoin(base, req.query.path || '');
  const st = fs.statSync(target);
  if (st.isFile()) return res.download(target);
  const name = (target === base ? req.params.id : path.basename(target)) + '.tar.gz';
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  tar.c({ gzip: true, cwd: path.dirname(target), portable: true }, [path.basename(target)]).pipe(res);
});

module.exports = router;
