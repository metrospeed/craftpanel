const path = require('path');
const { spawn } = require('child_process');
const http = require('../util/http');

function cmpVersion(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

const isStable = (v) => !/(snapshot|pre|rc|alpha|beta|experimental|-w|^\d+w\d+)/i.test(v);

function downloadTo(url, dir, file, log, opts = {}) {
  log(`Downloading ${file}...`);
  return http.download(url, path.join(dir, file), {
    ...opts,
    onProgress: (got, total) =>
      log(`  ${file}: ${http.formatBytes(got)}${total ? ' / ' + http.formatBytes(total) : ''}`),
  });
}

/** Run a child process to completion, streaming its output into the install log. */
function run(cmd, args, { cwd, log }) {
  return new Promise((resolve, reject) => {
    log(`$ ${path.basename(cmd)} ${args.join(' ')}`);
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = (chunk) => {
      tail += chunk.toString();
      const lines = tail.split(/\r?\n/);
      tail = lines.pop();
      for (const l of lines) if (l.trim()) log('  ' + l);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      if (tail.trim()) log('  ' + tail);
      code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} exited with code ${code}`));
    });
  });
}

module.exports = { cmpVersion, isStable, downloadTo, run };
