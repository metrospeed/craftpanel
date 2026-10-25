# CraftPanel

A self-hosted web panel for running Minecraft servers on a Linux machine, in the spirit of Multicraft:

- **One-click servers**: Paper, Purpur, Folia, Fabric, Forge, NeoForge, Vanilla, or your own jar. Pick a version and CraftPanel downloads and installs it.
- **Automatic Java**: each server gets the Java version its Minecraft version needs (8, 17, 21 or 25). Eclipse Temurin is downloaded on demand, so you don't install Java yourself.
- **Mods and plugins from Modrinth**: search, install with dependencies, update, enable/disable or remove, all from the browser. Manually uploaded jars are recognised too.
- **One domain for everything (Velocity)**: turn on the network and CraftPanel runs a Velocity proxy and keeps every config file in sync. Players join `play.example.com`, switch servers with `/server survival`, or go straight to `survival.play.example.com`.
- **Backups**: one-click and scheduled `.tar.gz` backups (taken safely while the server runs), retention, download, and one-click restore.
- **Live console** with colours and command history, CPU/RAM/player stats, a file manager with editor, upload (drag and drop), zip extraction, a `server.properties` editor with a MOTD designer (colours, bold/italic/underline, scrambled text, gradients on the network MOTD, centring and a live server-list preview), server icon upload (any image, converted to 64×64 with a cropper), daily scheduled restarts, auto-restart on crash, and multiple users with per-server access.

## Install

You need a Linux machine with systemd (Ubuntu, Debian, Fedora, Rocky/Alma, Arch, openSUSE…) on x86_64 or ARM64 (e.g. Raspberry Pi 4/5).

Run this one command as root (or with `sudo`):

```bash
curl -fsSL https://raw.githubusercontent.com/metrospeed/craftpanel/main/install.sh | sudo bash
```

On a fresh Debian/Proxmox container where you're already root and `curl` is missing:

```bash
apt-get update && apt-get install -y curl && curl -fsSL https://raw.githubusercontent.com/metrospeed/craftpanel/main/install.sh | bash
```

Prefer to read the script first? `git clone https://github.com/metrospeed/craftpanel && cd craftpanel && sudo ./install.sh` does the same thing from a local copy.

The installer:

1. installs `curl`/`tar` if missing and downloads a private copy of Node.js 22 into `/opt/craftpanel/node` (your system Node, if any, is untouched),
2. copies the panel to `/opt/craftpanel/app` and creates a `craftpanel` system user,
3. stores servers, backups and Java runtimes in `/var/lib/craftpanel`,
4. registers and starts the `craftpanel` systemd service,
5. opens port 8080 (panel) and 25565 (Minecraft) if `ufw` or `firewalld` is active.

Then open `http://<your-server-ip>:8080` and create the administrator account.

Options go after `bash -s --`, for example `curl -fsSL …/install.sh | sudo bash -s -- --port 9000`:
`--port 9000` (panel port), `--no-firewall`, `--uninstall` (keeps your data), `--purge` (deletes everything).

**Upgrading:** open **Settings → Updates** and click **Update now** (an "Update available" badge appears in the sidebar when GitHub has a newer version). Servers that were running are stopped safely and started again afterwards. Running the one-line install command again does the same thing.

Installs made before v1.1.0 don't have the updater yet: run the install command once more and the button works from then on.

### On Proxmox

CraftPanel runs well in an LXC container (tested on Proxmox VE with the Debian 13 template):

1. **Create CT** from `debian-13-standard`: unprivileged, **Options → Features → Nesting** on (needed for systemd).
2. Size it for your servers: 2 cores and 2 GB RAM for the panel plus the proxy, then add the memory you plan to give each Minecraft server (e.g. 4 GB per modded server). A 32 GB+ disk leaves room for worlds and backups.
3. Give it a static IP or a DHCP reservation, since your router forwards port 25565 to it.
4. Open the container's **Console** in Proxmox, log in as root and run:
   ```bash
   apt-get update && apt-get install -y curl && curl -fsSL https://raw.githubusercontent.com/metrospeed/craftpanel/main/install.sh | bash
   ```

Turn on **Start at boot** for the container: CraftPanel then starts with it and brings up every server marked "Start with the panel". CraftPanel's own backups cover individual servers; Proxmox `vzdump` snapshots of the whole container are a good extra layer.

## Using it

1. **New server**: choose a type, version and memory, accept the EULA. To bring an existing world (a singleplayer save or another server's world), upload it as a `.zip`/`.tar.gz` or pick its folder under **World**; otherwise a new world is generated. The console shows the install progress, then press **Start**.
2. **Plugins / Mods** tab: browse Modrinth (filtered to your loader and Minecraft version) and click Install. Restart the server to load new content.
3. **Backups** tab: back up now, or enable a schedule (e.g. every 6 hours, keep 10).
4. **Settings** tab: memory, port, autostart, daily restart time, JVM flags, and **Change version / reinstall** to update Minecraft.

### The network (one address for all servers)

Open **Network**, enter your domain (e.g. `play.example.com`) and click **Enable network**. CraftPanel creates a Velocity proxy on port 25565 and, for every server with "Join the network" ticked:

| | What CraftPanel configures |
|---|---|
| Velocity | modern forwarding, the forwarding secret, the server list, lobby/try order, per-server hostnames (`forced-hosts`), hot-reloads the proxy when anything changes |
| Paper / Purpur / Folia | `server-ip=127.0.0.1`, `online-mode=false`, `proxies.velocity` in `config/paper-global.yml` (or `paper.yml` before 1.19) |
| Fabric | installs **FabricProxy-Lite** (and Fabric API) and writes its secret |
| Forge / NeoForge | installs **Proxy-Compatible-Forge** and writes its secret |

Settings are applied the moment a server joins or leaves the network (or you enable/disable it), not just on its next start. Running servers with nobody online restart automatically; busy ones show **Restart needed**, and the proxy won't send players to them until they've restarted with the right settings.

Backend servers listen on `127.0.0.1` only, so nobody can bypass the proxy. Vanilla and custom jars can't do Velocity forwarding; they keep their own public port.

**DNS:** create an `A` record for `play.example.com` pointing at your public IP, and a wildcard `A` record `*.play.example.com` if you want per-server addresses. On Cloudflare use "DNS only" (grey cloud). Forward TCP 25565 on your router to the machine. The Network page shows the exact records to create.

## Ports

| Port | Used by |
|---|---|
| 8080 | Web panel (change with `--port`) |
| 25565 | Velocity proxy, which is where players connect |
| 25566+ | Individual servers (internal when in the network, public otherwise) |

## Security notes

- Put the panel behind HTTPS if you open it to the internet. Example with Caddy on the same machine:
  ```
  panel.example.com {
      reverse_proxy 127.0.0.1:8080
  }
  ```
  and set `CP_HOST=127.0.0.1` in `/etc/craftpanel.env` so the panel is only reachable through Caddy.
- Anyone with access to a server can upload plugins/mods, which run as the `craftpanel` user. Only give server access to people you trust.
- Only administrators can create/delete servers or change Java paths, JVM flags, memory, ports and the network.

## Files and service

```
/opt/craftpanel/app         panel code
/opt/craftpanel/node        bundled Node.js
/etc/craftpanel.env         CP_PORT, CP_HOST, CP_DATA_DIR, CP_REPO, CP_BRANCH
/etc/systemd/system/craftpanel-update.{path,service}   one-click updater (runs install.sh as root)
/var/lib/craftpanel/
  db.json                   panel settings, users, server list
  servers/<id>/             each server's files
  backups/<id>/             backups
  java/<major>/             downloaded Java runtimes
```

```bash
systemctl status craftpanel
journalctl -u craftpanel -f
sudo systemctl restart craftpanel    # gracefully stops servers, they autostart if enabled
```

Stopping or restarting the panel stops your Minecraft servers cleanly (they save first). Servers with **Start with the panel** enabled come back up automatically.

## Development

```bash
npm install
npm run dev          # http://localhost:8080, data in ./data
```

Environment variables: `CP_PORT`, `CP_HOST`, `CP_DATA_DIR`. The frontend is plain ES modules in `public/` (no build step); the backend is Express + `ws` in `src/`.
On non-Linux machines Java is taken from your `PATH` (set Settings → Java runtimes to "System"), and CPU/RAM stats are not shown.
