// Self-update from GitHub. The panel runs unprivileged, so it can't replace
// its own files; instead it drops a request file that a root-owned systemd
// path unit (craftpanel-update.path, created by install.sh) watches. That unit
// re-runs the official installer, which upgrades and restarts the panel.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const http = require('./util/http');
const store = require('./store');
const { cmpVersion } = require('./providers/common');

const REPO = process.env.CP_REPO || 'metrospeed/craftpanel';
const BRANCH = process.env.CP_BRANCH || 'main';
const REQUEST_FILE = path.join(config.paths.data, 'update.request');
const LOG_FILE = path.join(config.paths.data, 'update.log');
const RESUME_FILE = path.join(config.paths.data, 'resume.json');
const PATH_UNIT = '/etc/systemd/system/craftpanel-update.path';
const CHECK_INTERVAL_MS = 6 * 3600 * 1000;

function installedCommit() {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'BUILD_COMMIT'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

const canSelfUpdate = () => process.platform === 'linux' && fs.existsSync(PATH_UNIT);

let cache = null;

async function check({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.checkedAt < 5 * 60 * 1000) return status();
  const current = installedCommit();
  try {
    const [commit, history, pkg] = await Promise.all([
      http.getJson(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { headers: { Accept: 'application/vnd.github+json' } }),
      http
        .getJson(`https://api.github.com/repos/${REPO}/commits?sha=${BRANCH}&per_page=15`, { headers: { Accept: 'application/vnd.github+json' } })
        .catch(() => []),
      http.getJson(`https://raw.githubusercontent.com/${REPO}/${BRANCH}/package.json?t=${Date.now()}`).catch(() => null),
    ]);
    // Commits newer than the installed one, newest first.
    const changes = [];
    for (const c of history) {
      if (current && c.sha === current) break;
      changes.push({ sha: c.sha.slice(0, 7), message: c.commit.message.split('\n')[0], date: c.commit.committer?.date });
    }
    const latestVersion = pkg?.version || null;
    const updateAvailable = current
      ? commit.sha !== current
      : !!latestVersion && cmpVersion(latestVersion, config.version) > 0;
    cache = {
      checkedAt: Date.now(),
      latestCommit: commit.sha,
      latestVersion,
      latestDate: commit.commit?.committer?.date,
      updateAvailable,
      changes: current ? changes : changes.slice(0, 5),
      error: null,
    };
  } catch (err) {
    cache = { ...(cache || {}), checkedAt: Date.now(), error: `Could not reach GitHub: ${err.message}` };
  }
  return status();
}

function lastLog() {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
    const st = fs.statSync(LOG_FILE);
    return { at: st.mtime.toISOString(), tail: text.trim().split('\n').slice(-15).join('\n') };
  } catch {
    return null;
  }
}

function status() {
  const current = installedCommit();
  return {
    repo: REPO,
    branch: BRANCH,
    currentVersion: config.version,
    currentCommit: current ? current.slice(0, 7) : null,
    latestVersion: cache?.latestVersion || null,
    latestCommit: cache?.latestCommit ? cache.latestCommit.slice(0, 7) : null,
    latestDate: cache?.latestDate || null,
    updateAvailable: !!cache?.updateAvailable,
    changes: cache?.changes || [],
    checkedAt: cache?.checkedAt ? new Date(cache.checkedAt).toISOString() : null,
    error: cache?.error || null,
    canSelfUpdate: canSelfUpdate(),
    pending: fs.existsSync(REQUEST_FILE),
    lastLog: lastLog(),
  };
}

/** Ask systemd to run the installer. Running servers are remembered and restarted afterwards. */
function requestUpdate(servers) {
  if (!canSelfUpdate()) {
    const err = new Error(
      'One-click updates need the CraftPanel systemd updater. Run the install command on the server once to add it: ' +
        `curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/install.sh | sudo bash`,
    );
    err.status = 400;
    throw err;
  }
  const running = store.db.servers.filter((s) => servers.isRunning(s.id)).map((s) => s.id);
  fs.writeFileSync(RESUME_FILE, JSON.stringify({ servers: running, at: new Date().toISOString() }));
  fs.writeFileSync(REQUEST_FILE, `${new Date().toISOString()}\n`);
  return { ok: true, resume: running };
}

/** Server ids that were running before an update, consumed once at boot. */
function takeResumeList() {
  try {
    const { servers } = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8'));
    fs.rmSync(RESUME_FILE, { force: true });
    return Array.isArray(servers) ? servers : [];
  } catch {
    return [];
  }
}

function startBackgroundChecks() {
  setTimeout(() => check().catch(() => {}), 30 * 1000);
  setInterval(() => check().catch(() => {}), CHECK_INTERVAL_MS);
}

module.exports = { check, status, requestUpdate, takeResumeList, startBackgroundChecks, installedCommit };
