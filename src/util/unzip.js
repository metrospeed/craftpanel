// Small ZIP extractor (stored + deflate, including zip64 sizes) so users can
// upload zipped worlds or modpacks without needing `unzip` on the host.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { safeJoin, isMacJunk } = require('./fsutil');

function readEntries(fd, size) {
  const tailLen = Math.min(size, 65557);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) throw new Error('Not a zip file');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]));
    if (loc === -1) throw new Error('Corrupt zip64 archive');
    const z64Offset = Number(tail.readBigUInt64LE(loc + 8));
    const rec = Buffer.alloc(56);
    fs.readSync(fd, rec, 0, 56, z64Offset);
    count = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const method = cd.readUInt16LE(p + 10);
    let compSize = cd.readUInt32LE(p + 20);
    let uncompSize = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let localOffset = cd.readUInt32LE(p + 42);
    const name = cd.slice(p + 46, p + 46 + nameLen).toString('utf8');
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (uncompSize === 0xffffffff) (uncompSize = Number(cd.readBigUInt64LE(q))), (q += 8);
        if (compSize === 0xffffffff) (compSize = Number(cd.readBigUInt64LE(q))), (q += 8);
        if (localOffset === 0xffffffff) localOffset = Number(cd.readBigUInt64LE(q));
      }
      e += 4 + len;
    }
    entries.push({ name, method, compSize, uncompSize, localOffset });
    p = extraEnd + commentLen;
  }
  return entries;
}

function readData(fd, entry) {
  const header = Buffer.alloc(30);
  fs.readSync(fd, header, 0, 30, entry.localOffset);
  const dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const data = Buffer.alloc(entry.compSize);
  fs.readSync(fd, data, 0, entry.compSize, dataStart);
  if (entry.method === 0) return data;
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error(`Unsupported compression in ${entry.name}`);
}

/** Extract everything except macOS metadata (__MACOSX, ._*, .DS_Store). */
function extract(zipFile, destDir) {
  const fd = fs.openSync(zipFile, 'r');
  try {
    const entries = readEntries(fd, fs.fstatSync(fd).size);
    let files = 0;
    for (const entry of entries) {
      if (isMacJunk(entry.name)) continue;
      const target = safeJoin(destDir, entry.name);
      if (entry.name.endsWith('/')) {
        fs.mkdirSync(target, { recursive: true });
        continue;
      }
      const out = readData(fd, entry);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, out);
      files++;
    }
    return files;
  } finally {
    fs.closeSync(fd);
  }
}

/** Contents of one entry (e.g. pack.mcmeta) as a Buffer, or null if the zip doesn't have it. */
function readEntry(zipFile, name) {
  const fd = fs.openSync(zipFile, 'r');
  try {
    const entry = readEntries(fd, fs.fstatSync(fd).size).find((e) => e.name === name);
    return entry ? readData(fd, entry) : null;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { extract, readEntry };
