# Setup and Troubleshooting

VulnPen supports macOS, Linux, and Windows through WSL2. The default
Docker deployment is local-only: application and infrastructure ports bind to
`127.0.0.1`.

## Setup matrix

| Priority | Environment or failure | What VulnPen does | What you should do |
| --- | --- | --- | --- |
| P0 | Native Windows PowerShell, CMD, or Git Bash | The launcher stops before creating partial configuration. | Install WSL2, enable Docker Desktop's WSL integration, and clone the repository inside the WSL filesystem. |
| P0 | Remote Docker context | The launcher rejects `ssh://` and `tcp://` Docker endpoints because bind mounts would point at the remote machine. | Switch to a local context with `docker context use default` or run the repository on the Docker host. |
| P0 | Public or LAN exposure | Compose binds every published port to loopback. Production mode refuses non-HTTPS frontend/CORS settings. | Keep the default for a workstation. For remote access, use the reverse-proxy procedure below. |
| P0 | Open registration | Only the first account can register. The UI hides registration afterward, and the API also enforces it with a unique installation-owner record. | Create the owner account once and retain its credentials. |
| P0 | Invalid model key, model name, URL, or subscription login | **Test & Save** performs real inference. Unverified models cannot satisfy onboarding. | Correct the error shown by the model test. For a local Docker-hosted API, use `host.docker.internal`, not `localhost`. |
| P0 | Upgrade from the session-only data model | MongoDB migrations run automatically before readiness succeeds and are idempotent after an interrupted start. | Let startup finish; inspect `./run.sh logs backend` if readiness fails. |
| P0 | Lost MongoDB, Redis, configuration, or workspaces | `./run.sh backup` exports both databases and archives configuration and persistent workspace paths with owner-only permissions. | Back up before upgrades. Never run `docker compose down -v` unless you intend to delete Docker volumes. |
| P0 | Untrusted SSH server | External SSH profiles require a matching `known_hosts` entry, including nonstandard ports. | Connect once with the normal `ssh alias` command and verify the fingerprint, then retry. |
| P0 | VPN bundle uses separate certificates, keys, PKCS#12, or credentials | The uploader accepts one `.ovpn`/`.conf` plus up to 15 referenced assets, stores them with restrictive permissions, and uploads them together. | Select all bundle files in the file chooser. Interactive `auth-user-pass` prompts are rejected; include a credentials file or connect manually. |
| P0 | Stale VPN PID or another OpenVPN process on the work host | Status and disconnect operations only act on PID files and command lines created by VulnPen. | Manage unrelated VPN processes outside VulnPen. |
| P0 | Browser target is only reachable through the SSH host's VPN | The Browser Agent settings warn that the browser runs beside the backend, not on the SSH work host. | Connect the VPN in the backend/local work host, or expose an HTTP/SOCKS proxy reachable by the backend. |
| P0 | Backend compromise reaches the Docker daemon | The backend no longer mounts the Docker socket or controls work hosts through Docker APIs. | No action required. |
| P1 | Docker missing, stopped, old, or Compose v1 | The launcher checks Docker Engine 20+, Compose v2, and daemon connectivity. | Install/update Docker Desktop or Docker Engine plus the Compose plugin. |
| P1 | Port collision | Before a first start, the launcher identifies occupied TCP ports and the owning listener where the OS exposes it. | Stop the listener, then retry. The standard ports are 3000, 8080, 6080, 9020, 27017, and 6379; Kali adds 4200, 4242, and 5901. |
| P1 | Low disk or memory | The launcher warns below 20 GB free disk or 8 GB RAM. | Free disk, increase Docker Desktop resources, reduce concurrent agents, or avoid the built-in Kali desktop. |
| P1 | ARM64 host | The launcher warns because some third-party Kali tools are x86_64-only. | Use core mode with an ARM64 work host where possible; install unsupported tools manually or use an x86_64 attack box. |
| P1 | Rootless Docker | The launcher warns and blocks built-in Kali, which needs privileged networking. | Use core mode with an external SSH work host, or switch to non-rootless Docker. Local OpenVPN also needs `NET_ADMIN` and `/dev/net/tun`. |
| P1 | Repository or SSH folder permission error | The launcher checks repository writability; workspace selection performs a real create/write/delete probe. Mounts are read-only where possible. | Fix ownership for the clone/workspace. In Docker, use container-visible paths and ensure Docker Desktop can share the directory. |
| P1 | SSH config split with `Include` | Concrete aliases in common include files and `config.d/*` globs are discovered. Wildcard-only hosts are intentionally not shown. | Select a concrete alias. Set `HOST_SSH_DIR` before start if `.ssh` lives somewhere else. |
| P1 | Private key outside `.ssh`, encrypted key, or SSH agent | `~/.ssh`, `~/keys`, and `ssh-keys/` are supported; a live `SSH_AUTH_SOCK` is mounted automatically and preferred. | Set `HOST_SSH_KEYS_DIR`, copy a key into `ssh-keys/`, or run `ssh-add` before `./run.sh start`. Never commit keys. |
| P1 | `ProxyJump` or `ProxyCommand` SSH profile | The connection test reports that embedded SSH cannot use that profile instead of silently trying the wrong direct route. | Create a local SSH tunnel/direct alias reachable by the backend, then select that alias. |
| P1 | Non-Debian Linux work host | Automatic APT-based capability installs stop with a specific distro message. macOS uses Homebrew when supported. | Install the capability with the host's package manager, then run capability detection again. |
| P1 | Slow package install | Capability installation allows up to ten minutes. | Watch the terminal output; preinstall very large GUI tools if the network is slow. |
| P1 | Corporate proxy or custom CA | Docker build proxy variables are detected. A valid host `NODE_EXTRA_CA_CERTS` file is mounted into the backend automatically. | Export `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and/or `NODE_EXTRA_CA_CERTS` before starting. Configure Docker Desktop's own proxy/CA trust for image pulls and builds. |
| P1 | Development mode | The launcher checks pnpm, installs locked dependencies, starts only MongoDB/Redis (optionally Kali), and prints the exact three local commands. | Use Node 22+ and pnpm 9+. Install Patchright Chromium when prompted if Browser Agent is needed. |
| P2 | SELinux enforcing on Linux | Docker may reject or isolate bind mounts even when Unix ownership looks correct. | Prefer rootless-safe core mode or label the specific repository bind paths for container access according to your distribution policy. Do not disable SELinux globally. |
| P2 | Air-gapped or intermittently connected host | Existing images and installed models continue to work; first builds, browser downloads, package installs, and hosted model tests need their upstreams. | Pre-pull/build images and preinstall tools while online, then use a reachable local model endpoint. |
| P2 | Multiple clones running together | The launcher rejects an existing Compose project owned by another working directory; fixed host ports are also checked. | Run one clone at a time unless you deliberately assign unique Compose project names, ports, and frontend/backend URLs. |
| P2 | Workspace path contains spaces | Local and SSH work folders are shell-quoted and tested before saving. | Select an absolute path (`~` is accepted for SSH). Avoid newline/control characters, which are rejected. |
| P2 | IPv6-only target or unusual DNS | Command execution uses the work host's network and resolver; individual pentest tools determine IPv6 support. | Verify resolution and routing in the workspace terminal, then choose IPv6-capable tool flags. |

## Normal installation

```bash
git clone <repository-url>
cd vulnpen
./run.sh start
```

The compose stack serves the backend API only — the frontend runs on your host
via `pnpm run dev` inside `frontend/` (the launcher prints the commands) or
behind the reverse proxy in the TLS procedure below. Open the frontend URL
(`http://localhost:3000` in dev), create the installation-owner account, then add
and verify an orchestrator under **Settings → Models**. Open a workspace's
**Connection** page and save a local folder or tested SSH alias.

For subsequent starts, use `./run.sh start -q`. Useful diagnostics are:

```bash
./run.sh status
./run.sh logs backend
docker compose config
```

## Windows with WSL2

1. Install WSL2 and a Linux distribution.
2. Enable that distribution under Docker Desktop → Resources → WSL Integration.
3. In the WSL terminal, clone under `~/`, not `/mnt/c`.
4. Run `./run.sh start` from WSL and open the printed localhost URL in Windows.

If Docker is unavailable inside WSL, fix Docker Desktop integration rather than
installing a second Docker daemon inside the distribution.

## SSH checklist

The backend resolves OpenSSH aliases with `ssh -G`. Confirm the same alias works
outside VulnPen first:

```bash
ssh-add -l                 # if the key is loaded in an agent
ssh-keygen -F lab-box      # use [host]:port for a nonstandard port
ssh -v lab-box
```

In Docker, `localhost` means the backend container. To reach a service on the
Docker host, use `host.docker.internal`. To reach the built-in Kali container,
use the generated `kali` profile/default rather than host port 4242.

## Backups and recovery

Run:

```bash
./run.sh backup
```

The timestamped directory under `backups/` contains MongoDB and Redis exports,
configuration (including secrets), Kali data when present, and backend workspace
data in Docker mode. Copy it to encrypted storage. A restore replaces live data,
so stop the application and restore with the native `mongorestore`, Redis
`dump.rdb`, and `tar` tools after reviewing the archive contents; keep the
original backup untouched until the restored stack passes its health check.

## Reverse proxy and TLS

The supported default is workstation-local. If remote access is required:

1. Keep Compose ports on `127.0.0.1`.
2. Put an authenticated TLS reverse proxy on the same host. Start from
   `deploy/Caddyfile.example`; do not proxy MongoDB, Redis, Kali SSH/shell, or
   the unauthenticated noVNC port.
3. Set `deployment = "PROD"`, `base_url_frontend`, and `cors_origins` to the
   same explicit HTTPS origin in `config.toml`.
4. Set `NEXT_PUBLIC_BACKEND_URI` to that HTTPS origin in `frontend/.env`, then
   rebuild the frontend.
5. Restart and verify login, API requests, shell WebSockets, and registration
   closure from a private browser window.

Production startup fails closed when the frontend URL or CORS origins are not
HTTPS or the session secret is shorter than 32 characters.

## Updating

```bash
./run.sh backup
git pull --ff-only
./run.sh start
```

Choose the rebuild option after pulling code. Automatic migrations complete
before the health endpoint reports ready. Do not use `docker compose down -v`
during a normal update.

## Accounts and registration

VulnPen allows new accounts by default: the first account created on a fresh installation becomes the installation owner, and later accounts join as members. To close registration once the accounts you need exist, set the following in `backend/.env` (or as an environment variable on the backend container) and restart the backend:

```env
ALLOW_REGISTRATION=false
```

With registration closed, the sign-up form stays visible, but the API refuses new accounts with `403 Registration is closed on this installation` and points people at signing in with an existing account.

There is no self-service password reset or account deletion yet; accounts are managed on the server side (`backend/.env` + MongoDB) until an admin UI lands.

## Database name

New installations keep their data in a MongoDB database called `vulnpen`. Installations from earlier releases used a different database name, and an upgrade does not move data by itself: the backend uses whatever `config.toml` points at, so an existing installation keeps running on its current database until you decide to migrate.

To adopt the new name:

```bash
# dry run first - prints what would be copied, writes nothing
docker compose exec backend pnpm migrate:db-name

# copy documents and indexes from the old database into the new one
docker compose exec backend pnpm migrate:db-name --yes

# then point the backend at the new database and restart
#   [database]
#   mongo_uri = mongodb://mongodb:27017/vulnpen
#   mongo_database = vulnpen
docker compose restart backend
```

The source database is detected automatically when the server holds exactly one other database. Pass it explicitly when detection is ambiguous: `docker compose exec backend pnpm migrate:db-name --yes --from <database-name>` (or set `LEGACY_MONGO_DATABASE`). The migration never writes to or drops the source database, so rolling back is a matter of restoring the previous `mongo_uri`. It is also safe to re-run: documents are upserted by `_id` and indexes are recreated idempotently.

Container names are now fixed (`vulnpen-mongodb`, `vulnpen-redis`, `vulnpen-backend`, `vulnpen-kali`) so tooling finds them no matter which directory the project was cloned into. Docker volume names are unchanged, so no existing data is affected.
