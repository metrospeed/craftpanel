// Minimal Minecraft Server List Ping client, used to read player counts.
const net = require('net');

function varInt(n) {
  const bytes = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    bytes.push(b);
  } while (n);
  return Buffer.from(bytes);
}

function readVarInt(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (true) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value: result, size: pos - offset };
    shift += 7;
    if (shift > 35) throw new Error('VarInt too big');
  }
}

function packet(id, payload) {
  const body = Buffer.concat([varInt(id), payload]);
  return Buffer.concat([varInt(body.length), body]);
}

function ping(host, port, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    const done = (err, val) => {
      socket.destroy();
      err ? reject(err) : resolve(val);
    };
    socket.setTimeout(timeout, () => done(new Error('timeout')));
    socket.on('error', (e) => done(e));
    socket.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      const handshake = packet(0x00, Buffer.concat([varInt(767), varInt(hostBuf.length), hostBuf, portBuf, varInt(1)]));
      socket.write(Buffer.concat([handshake, packet(0x00, Buffer.alloc(0))]));
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const len = readVarInt(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        const id = readVarInt(buf, len.size);
        const strLen = readVarInt(buf, len.size + id.size);
        const start = len.size + id.size + strLen.size;
        const json = JSON.parse(buf.slice(start, start + strLen.value).toString('utf8'));
        done(null, {
          online: json.players?.online ?? 0,
          max: json.players?.max ?? 0,
          sample: (json.players?.sample || []).map((p) => p.name),
          version: json.version?.name,
        });
      } catch (e) {
        done(e);
      }
    });
  });
}

module.exports = { ping };
