// CPU / memory usage for a process tree, read straight from /proc on Linux.
const fs = require('fs');
const os = require('os');

const CLK_TCK = 100;
const PAGE = 4096;
const prev = new Map();

function readStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return {
      ppid: Number(fields[1]),
      ticks: Number(fields[11]) + Number(fields[12]),
      rss: Number(fields[21]) * PAGE,
    };
  } catch {
    return null;
  }
}

function children(pid) {
  try {
    return fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

/** Returns { cpu: percent of one core, memory: bytes } summed over the tree. */
function usage(pid) {
  if (process.platform !== 'linux' || !pid) return null;
  let ticks = 0;
  let rss = 0;
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop();
    const s = readStat(p);
    if (!s) continue;
    ticks += s.ticks;
    rss += s.rss;
    stack.push(...children(p));
  }
  const now = Date.now();
  const last = prev.get(pid);
  prev.set(pid, { ticks, at: now });
  const cpu = last ? (((ticks - last.ticks) / CLK_TCK) / ((now - last.at) / 1000)) * 100 : 0;
  return { cpu: Math.max(0, Math.round(cpu * 10) / 10), memory: rss };
}

function forget(pid) {
  prev.delete(pid);
}

function system() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  // Linux uses otherwise idle RAM for reclaimable caches. MemAvailable is
  // the estimate of what applications can use without swapping, including
  // the container-specific figures supplied by lxcfs on Proxmox.
  let availableMem = freeMem;
  try {
    const match = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+)\s+kB\s*$/m);
    if (match) availableMem = Math.min(totalMem, Number(match[1]) * 1024);
  } catch {
    // Other platforms and older Linux kernels still report free memory.
  }
  return {
    cores: cpus.length,
    load: os.loadavg(),
    totalMem,
    freeMem,
    availableMem,
    uptime: os.uptime(),
    platform: `${os.type()} ${os.release()}`,
    hostname: os.hostname(),
  };
}

module.exports = { usage, forget, system };
