#!/usr/bin/env bash
# CraftPanel installer for Linux (Debian/Ubuntu, Fedora/RHEL, Arch, openSUSE).
#
# One-line install or upgrade (downloads the latest code from GitHub):
#   curl -fsSL https://raw.githubusercontent.com/metrospeed/craftpanel/main/install.sh | sudo bash
#
# Options (append after "sudo bash -s --" when piping, or pass to ./install.sh):
#   --port 9000      use a different web panel port (default 8080)
#   --no-firewall    don't open ports in ufw/firewalld
#   --uninstall      remove the panel, keep server data
#   --purge          remove the panel AND all servers, backups and data
#
# Environment overrides: CP_INSTALL_DIR (default /opt/craftpanel),
# CP_DATA_DIR (default /var/lib/craftpanel), CP_USER (default craftpanel),
# CP_REPO (default metrospeed/craftpanel), CP_BRANCH (default main).
set -euo pipefail

# Everything runs inside this block so bash reads the whole script before
# executing it; otherwise commands reading stdin could eat a piped script.
{

INSTALL_DIR="${CP_INSTALL_DIR:-/opt/craftpanel}"
DATA_DIR="${CP_DATA_DIR:-/var/lib/craftpanel}"
SERVICE_USER="${CP_USER:-craftpanel}"
SERVICE_NAME="craftpanel"
ENV_FILE="/etc/craftpanel.env"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
UPDATE_SERVICE="/etc/systemd/system/${SERVICE_NAME}-update.service"
UPDATE_PATH="/etc/systemd/system/${SERVICE_NAME}-update.path"
NODE_MAJOR=22
PANEL_PORT=""
OPEN_FIREWALL=1
ACTION="install"
REPO="${CP_REPO:-metrospeed/craftpanel}"
BRANCH="${CP_BRANCH:-main}"
ORIG_ARGS=("$@")
# When piped from curl there is no script file, and the code is downloaded later.
SCRIPT_FILE=""
SRC_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SCRIPT_FILE="${BASH_SOURCE[0]}"
  SRC_DIR="$(cd "$(dirname "$SCRIPT_FILE")" && pwd)"
fi
CLEANUP=()
trap 'rm -rf ${CLEANUP[@]+"${CLEANUP[@]}"}' EXIT

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PANEL_PORT="${2:?--port needs a value}"; shift 2 ;;
    --no-firewall) OPEN_FIREWALL=0; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    --purge) ACTION="purge"; shift ;;
    -h|--help) echo "Usage: install.sh [--port N] [--no-firewall] [--uninstall] [--purge]"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  [ -n "$SCRIPT_FILE" ] || die "please run as root: curl -fsSL https://raw.githubusercontent.com/$REPO/$BRANCH/install.sh | sudo bash"
  command -v sudo >/dev/null 2>&1 || die "please run as root"
  exec sudo -E bash "$SCRIPT_FILE" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
fi

[ "$(uname -s)" = "Linux" ] || die "this installer only supports Linux"
command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || die "systemd is required"

# --- uninstall ---------------------------------------------------------------

if [ "$ACTION" != "install" ]; then
  info "Stopping CraftPanel (this gracefully stops all Minecraft servers)..."
  systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  systemctl disable --now "${SERVICE_NAME}-update.path" 2>/dev/null || true
  rm -f "$UNIT_FILE" "$UPDATE_SERVICE" "$UPDATE_PATH" "$ENV_FILE"
  systemctl daemon-reload
  rm -rf "$INSTALL_DIR"
  if [ "$ACTION" = "purge" ]; then
    rm -rf "$DATA_DIR"
    userdel "$SERVICE_USER" 2>/dev/null || true
    info "CraftPanel and all data removed."
  else
    info "CraftPanel removed. Your servers and backups are still in $DATA_DIR"
  fi
  exit 0
fi

# --- prerequisites -------------------------------------------------------------

install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q "$@"
  elif command -v yum >/dev/null 2>&1; then
    yum install -y -q "$@"
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm --needed "$@" >/dev/null
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install "$@" >/dev/null
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache "$@" >/dev/null
  else
    die "no supported package manager found; install $* manually"
  fi
}

need=()
for bin in curl tar gzip; do command -v "$bin" >/dev/null 2>&1 || need+=("$bin"); done
[ -f /etc/ssl/certs/ca-certificates.crt ] || [ -f /etc/pki/tls/certs/ca-bundle.crt ] || need+=(ca-certificates)
if [ ${#need[@]} -gt 0 ]; then
  info "Installing ${need[*]}..."
  install_packages "${need[@]}"
fi

# --- CraftPanel source -------------------------------------------------------------

if [ -z "$SRC_DIR" ] || [ ! -f "$SRC_DIR/package.json" ] || [ ! -d "$SRC_DIR/src" ]; then
  info "Downloading CraftPanel ($REPO@$BRANCH)..."
  # Pin the exact commit so the panel knows which version it's running.
  BUILD_COMMIT="$(curl -fsSL "https://api.github.com/repos/$REPO/commits/$BRANCH" 2>/dev/null | grep -m1 '"sha"' | cut -d'"' -f4 || true)"
  ref="${BUILD_COMMIT:-refs/heads/$BRANCH}"
  src_tmp="$(mktemp -d)"
  CLEANUP+=("$src_tmp")
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$ref" | tar -xz -C "$src_tmp" --strip-components=1     || die "could not download https://github.com/$REPO"
  SRC_DIR="$src_tmp"
  [ -f "$SRC_DIR/package.json" ] || die "downloaded archive does not look like CraftPanel"
fi

case "$(uname -m)" in
  x86_64|amd64) NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  armv7l) NODE_ARCH=armv7l ;;
  *) die "unsupported CPU architecture: $(uname -m)" ;;
esac

# --- Node.js runtime (private copy, doesn't touch the system node) --------------

NODE_DIR="$INSTALL_DIR/node"
NODE_BIN="$NODE_DIR/bin/node"
current_major=0
[ -x "$NODE_BIN" ] && current_major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$current_major" -lt "$NODE_MAJOR" ]; then
  info "Downloading Node.js $NODE_MAJOR ($NODE_ARCH)..."
  tmp="$(mktemp -d)"
  CLEANUP+=("$tmp")
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(grep -o "node-v[0-9.]*-linux-${NODE_ARCH}\.tar\.gz" "$tmp/SHASUMS256.txt" | head -n1)"
  [ -n "$file" ] || die "could not find a Node.js build for linux-$NODE_ARCH"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || die "Node.js checksum verification failed"
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xzf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
fi
info "Using Node.js $("$NODE_BIN" -v)"

# --- service user & files ---------------------------------------------------------

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  info "Creating system user '$SERVICE_USER'..."
  nologin="$(command -v nologin || echo /usr/sbin/nologin)"
  useradd --system --home-dir "$DATA_DIR" --shell "$nologin" --user-group "$SERVICE_USER"
fi
mkdir -p "$DATA_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

UPGRADE=0
systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null && UPGRADE=1
if [ "$UPGRADE" = 1 ]; then
  info "Stopping running panel for upgrade (servers are stopped gracefully)..."
  systemctl stop "$SERVICE_NAME"
fi

info "Installing CraftPanel to $INSTALL_DIR/app..."
APP_DIR="$INSTALL_DIR/app"
rm -rf "$APP_DIR.new"
mkdir -p "$APP_DIR.new"
cp -r "$SRC_DIR/src" "$SRC_DIR/public" "$SRC_DIR/package.json" "$APP_DIR.new/"
if [ -z "${BUILD_COMMIT:-}" ] && command -v git >/dev/null 2>&1 && [ -d "$SRC_DIR/.git" ]; then
  BUILD_COMMIT="$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || true)"
fi
[ -n "${BUILD_COMMIT:-}" ] && echo "$BUILD_COMMIT" > "$APP_DIR.new/BUILD_COMMIT"
[ -f "$SRC_DIR/package-lock.json" ] && cp "$SRC_DIR/package-lock.json" "$APP_DIR.new/"
[ -f "$SRC_DIR/README.md" ] && cp "$SRC_DIR/README.md" "$APP_DIR.new/"
(
  cd "$APP_DIR.new"
  export PATH="$NODE_DIR/bin:$PATH" NPM_CONFIG_UPDATE_NOTIFIER=false
  if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund --loglevel=error; else npm install --omit=dev --no-audit --no-fund --loglevel=error; fi
)
rm -rf "$APP_DIR"
mv "$APP_DIR.new" "$APP_DIR"
chown -R root:root "$INSTALL_DIR"

# --- configuration ------------------------------------------------------------------

if [ -f "$ENV_FILE" ] && [ -z "$PANEL_PORT" ]; then
  PANEL_PORT="$(sed -n 's/^CP_PORT=//p' "$ENV_FILE")"
fi
PANEL_PORT="${PANEL_PORT:-8080}"
cat > "$ENV_FILE" <<EOF
# CraftPanel settings. Restart after editing: systemctl restart $SERVICE_NAME
CP_PORT=$PANEL_PORT
CP_HOST=0.0.0.0
CP_DATA_DIR=$DATA_DIR
NODE_ENV=production
# Where the Update button looks for new versions
CP_REPO=$REPO
CP_BRANCH=$BRANCH
EOF

cat > "$UNIT_FILE" <<EOF
[Unit]
Description=CraftPanel Minecraft server panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN $APP_DIR/src/index.js
Restart=on-failure
RestartSec=5
# The panel stops every Minecraft server cleanly on SIGTERM; give big worlds time to save.
KillMode=mixed
TimeoutStopSec=180
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

# One-click updates: the panel (unprivileged) creates update.request in its data
# folder; this root-owned path unit notices and re-runs the installer.
cat > "$UPDATE_SERVICE" <<EOF
[Unit]
Description=Update CraftPanel from GitHub

[Service]
Type=oneshot
EnvironmentFile=$ENV_FILE
ExecStartPre=/bin/rm -f $DATA_DIR/update.request
ExecStart=/bin/bash -c 'curl -fsSL "https://raw.githubusercontent.com/\${CP_REPO}/\${CP_BRANCH}/install.sh" | bash > $DATA_DIR/update.log 2>&1'
EOF

cat > "$UPDATE_PATH" <<EOF
[Unit]
Description=Watch for CraftPanel update requests

[Path]
PathExists=$DATA_DIR/update.request
Unit=${SERVICE_NAME}-update.service

[Install]
WantedBy=multi-user.target
EOF

# --- firewall -----------------------------------------------------------------------

if [ "$OPEN_FIREWALL" = 1 ]; then
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    info "Opening ports $PANEL_PORT (panel) and 25565 (Minecraft) in ufw..."
    ufw allow "$PANEL_PORT/tcp" >/dev/null
    ufw allow 25565/tcp >/dev/null
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    info "Opening ports $PANEL_PORT (panel) and 25565 (Minecraft) in firewalld..."
    firewall-cmd --permanent --add-port="$PANEL_PORT/tcp" >/dev/null
    firewall-cmd --permanent --add-port=25565/tcp >/dev/null
    firewall-cmd --reload >/dev/null
  fi
fi

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1
systemctl enable --now "${SERVICE_NAME}-update.path" >/dev/null 2>&1

for _ in $(seq 1 20); do
  curl -fs "http://127.0.0.1:$PANEL_PORT/api/auth/state" >/dev/null 2>&1 && break
  sleep 0.5
done
systemctl is-active --quiet "$SERVICE_NAME" || die "CraftPanel failed to start; check: journalctl -u $SERVICE_NAME -n 50"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
bold "CraftPanel is running!"
echo
echo "  Open:      http://${IP:-<this-server-ip>}:$PANEL_PORT"
[ "$UPGRADE" = 1 ] && echo "  Upgraded:  your servers and settings were kept." || echo "  First visit: create your administrator account."
echo "  Data:      $DATA_DIR"
echo "  Logs:      journalctl -u $SERVICE_NAME -f"
echo "  Service:   systemctl {status|restart|stop} $SERVICE_NAME"
echo
echo "  Players connect on port 25565. Forward it on your router to this machine"
echo "  if people outside your network should be able to join."
echo
exit 0
}
