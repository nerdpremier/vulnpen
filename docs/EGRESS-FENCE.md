# The egress fence

How VulnPen guarantees that a destructive request never reaches the engagement
target — and what that guarantee does and does not cover.

## The problem it replaces

The other boundaries read the *command* the agent is about to run
(`utils/targetSafety.ts`). That means reading a language the agent also
controls, and it can always be rephrased:

```
rm -rf /data                  →  caught
sudo rm -rf /data             →  same command, different first token
bash -c 'rm -rf /data'        →  same command, inside a string
echo cm0gLXJmIC9kYXRh | base64 -d | sh
python3 -c "import os; os.system('rm -rf /data')"
subprocess.run(["rm", "-rf", "/data"])
curl -X DELETE http://target/api/Users/1
```

Every one of those ends as the same thing on the wire. The fence judges *that*.

## How it works

The engagement target is a real system on the public internet. VulnPen — the
backend, the attack box, the databases — runs in Docker; the target does not.

```
        agent (curl, python, nmap, sqlmap, browser, a binary it compiled)
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │  egress fence (:3128)   │   src/egressProxy.ts
                    │  src/utils/egressPolicy │
                    └─────────────────────────┘
                                  │
                                  ▼
                  the engagement target (public internet)
```

The attack box has **no internet route of its own** — the fence is the only way
out of its network — so every tool the agent can reach is judged by the same
rules on the same wire request.

Two pieces:

- `src/utils/egressPolicy.ts` — `decideEgressRequest({ method, url, host, body },
  allowlist)`. It reuses the rules that already exist: `detectDestructiveTargetAction`
  for "does this remove or overwrite data" and `isHostInScope` / `checkScope` for
  "is this inside the engagement". Nothing new is invented — only relocated.
- `src/egressProxy.ts` — the process that calls it. Plain HTTP is fully judged.
  A `CONNECT` is refused by default; with `EGRESS_ALLOW_TLS=1` the fence
  terminates the TLS itself and judges the request inside it (see [TLS](#tls)).

### The fence is not a blanket allowlist

The box still has to install tools and look things up, and the target is one host
among many on the internet. So the rule is about **state**, not about
destination:

1. A destructive request is refused, whatever the destination.
2. Outside the engagement, a **read** passes (a tool download, an OSINT lookup);
   a **write**, or a request to an internal or unidentifiable host, does not.
3. Inside the engagement, a host named in the request is judged the same way —
   the destination would reach it on our behalf.

## What it guarantees

| Property | Strength |
|---|---|
| A request whose method is `DELETE` does not leave | **100%** — a method is a token, not an interpretation |
| A write (`POST`/`PUT`/`PATCH`/`DELETE`) to a host outside the engagement does not leave | **100%** |
| A read of a public host does not leave | allowed by design — a tool download and an OSINT lookup are reconnaissance, not engagement activity |
| A request whose method is not `GET`/`HEAD`/`OPTIONS`/`TRACE`/`POST`/`PUT`/`PATCH` (`MOVE`, `COPY`, `MKCOL`, `PURGE`, an invented verb) does not leave | **100%** — exact token match |
| A method override (`X-HTTP-Method-Override`, `X-HTTP-Method`, `_method`) that says `DELETE` does not leave, in a header, the query or the body | **100%** for those names |
| A body the fence cannot read in full (over `maxBody`, default 1 MiB, or a non-identity `Content-Encoding`), an `https:` absolute URL, a `CONNECT` tunnel or an `Upgrade` does not leave | **100%** — refused, never guessed at |
| Percent-encoded (also double-encoded) or `\uXXXX`-escaped statements and paths are judged in their decoded form | **100%** for those encodings |
| A request to a delete/disable endpoint (a path segment or query **key** naming one, such as `/deleteUser`, `/user-remove`, `?action=remove`), a GraphQL mutation named `delete*`/`remove*`, a destructive SQL statement, or a sqlmap write flag does not leave | best effort — "this POST removes data" is a judgement about meaning, and a novel endpoint name will not be recognised |
| A read whose query **value** happens to be a delete word (`?q=delete`, `?filter=trash`) | **allowed on purpose** — a value beside an ordinary key is what the caller searched for, not the name of the operation. Refusing it cost the agent every read of a page whose parameter merely spelled one. The method and the path still carry the guarantees above |
| Command-level evasion (`sudo`, `bash -c`, `base64 \| sh`, a script on disk) buys nothing | **100%** — the fence never reads the command |

The chokepoint removes the *evasion* problem. It does not remove the *semantics*
problem, and no fence can: `POST /api/Users/1/purge` deletes a user and looks
like nothing in particular.

## Making it unbypassable

The fence is only a fence if the box cannot route around it. That is a
networking change, not a code change:

```yaml
# docker-compose.kali.yml (sketch — adapt to your topology)
networks:
  control:      # backend ↔ kali: SSH, no internet
    internal: true
  fenced:       # kali ↔ fence only
    internal: true
  upstream: {}  # fence ↔ the public internet, where the target lives

services:
  egress:
    build: ./backend
    # The image's ENTRYPOINT is the backend's boot script, so it has to be
    # replaced rather than appended to.
    entrypoint: ["node", "dist/egressProxy.js"]
    environment:
      EGRESS_ALLOWLIST: "${EGRESS_ALLOWLIST:-}"   # the engagement target hosts
      EGRESS_PORT: "3128"
      EGRESS_ALLOW_TLS: "${EGRESS_ALLOW_TLS:-1}"  # terminate + judge CONNECT (see TLS)
    volumes:
      - ./kali-data:/kali-data                    # holds the fence's CA
    networks: [fenced, upstream]

  kali:
    # `privileged: true` also hands over the host's devices and lets the box
    # rewrite its own routing. Name what the tooling needs instead.
    cap_drop: [ALL]
    cap_add: [NET_ADMIN, NET_RAW]   # OpenVPN, nmap -sS, masscan
    devices: ["/dev/net/tun:/dev/net/tun"]
    environment:
      HTTP_PROXY: "http://egress:3128"
      HTTPS_PROXY: "http://egress:3128"
      NO_PROXY: "localhost,127.0.0.1,kali,backend,mongodb,redis,collabora"
    networks: [control, fenced]
```

`kali` is on `control` (to be driven) and `fenced` (to reach the fence), and on
nothing else — it has no route to the internet, so the fence is the only way to
reach the target at all. `NO_PROXY` deliberately does not include the target:
the target must be reached *through* the fence.

### The browser agent is behind the fence too

The browser runs **on the attack box**, alongside the other tools, so the fence
covers it the same way it covers `curl` or `sqlmap` — by network position, not by
configuration.

```
        agent (curl, python, nmap, sqlmap, chromium, a binary it compiled)
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │  egress fence (:3128)   │   src/egressProxy.ts
                    └─────────────────────────┘
                                  │
                                  ▼
                  the engagement target (public internet)
```

The backend does not run Chromium. It launches it on the attack box over SSH and
attaches over CDP through a **loopback-only SSH tunnel**, so the browser is a
process on the fenced box and has no route of its own — exactly like every other
tool there (`services/remote-browser.service.ts`).

Point it at the fence by name:

```bash
MAGNITUDE_PROXY_URL=http://egress:3128
```

This is what `docker-compose.kali.yml` defaults to. The value is addressed the way
the **attack box** reaches the proxy, not the backend: a host naming the attack
box itself (`kali`, `localhost`, `$SSH_HOST`) is rewritten to `127.0.0.1` before
the browser is launched there, and anything else — the fence, an external proxy —
is passed through unchanged.

Leaving it empty means the browser egresses directly from the attack box. That is
still inside the fenced network, so it still cannot reach anything: it fails
rather than silently bypassing the fence.

> **History.** The browser used to run in the backend container, which also needs
> Mongo, Redis and the model API — so network isolation could not cover it, and
> the only thing standing between the browser and the internet was this one
> setting being filled in correctly. Moving the browser to the attack box closed
> that hole rather than documenting around it.

### Configuring the fence's allowlist

Set the allowlist from the engagement:

```bash
EGRESS_ALLOWLIST="$(host_from_session_target)" docker compose up -d egress
```

An unarmed fence refuses to start (`assertEgressProxyArmed`): with no declared
Target there is no allowlist, and serving every request uninspected would look
like a fence while being none.

## TLS

Refused by default. A `CONNECT` tunnel is opaque — everything inside it is
encrypted between the client and the real destination — so a fence that lets one
through is not a fence for what travels inside it.

`EGRESS_ALLOW_TLS=1` does not change that trade-off; it removes it. The fence
terminates the TLS itself, decrypts, and hands the plaintext request to **the
exact same handler** — and therefore the same `decideEgressRequest` — that
already governs plain HTTP. HTTPS gets the same guarantees HTTP already has; the
two 100% rows above keep applying inside the "tunnel", because there is no
longer a tunnel, only a request the fence can read.

How the interception is wired:

- **A CA, generated once** (`src/utils/egressCa.ts`). On the first boot with TLS
  on, the fence mints a 2048-bit RSA CA and signs a leaf certificate per
  destination host on demand (with a DNS or IP SAN, cached in memory). The CA is
  persisted to `/kali-data/egress-ca/{ca.crt,ca.key}` — the bind mount the
  `egress`, `backend` and `kali` containers share — so it survives restarts and
  every tool keeps trusting the same one. The **private key never leaves the
  fence process**; the backend only ever reads the public certificate.
- **Trust distribution** (`src/services/egress-ca-trust.service.ts`). Every
  HTTPS client on the attack box has to trust that CA or it fails the handshake
  on an unknown issuer. Two stores, two paths:
  - Chromium (the browser agent) reads the profile's NSS database — the same
    store and `certutil` sequence Burp's CA already uses, installed side by side
    under `VulnPen Egress Fence CA`.
  - `curl`, `python`, `nmap`, `sqlmap`, … read the OS trust store. The service
    copies the CA to `/usr/local/share/ca-certificates/` on the attack box and
    runs `update-ca-certificates` over SSH. Burp's flow never needed this
    because Burp validates its own upstream TLS loosely; a plain client pointed
    at the fence does not.

  A watcher (mirroring `startBurpCaWatcher`) installs the CA as soon as the
  fence has generated it and re-installs it if the fence's CA ever rotates.
- **The upstream leg is ordinary TLS.** The fence re-encrypts to the real
  destination with `rejectUnauthorized: true` — a normal, fully-validated
  outbound connection. Only the client-facing side is intercepted; the fence
  never lowers the bar for the connection to the target.

The CA's public certificate is also served unauthenticated at
`http://egress:3128/__egress_ca__/ca.der`, mirroring Burp's own `/cert`, for any
client that would rather fetch it than read it off the shared mount.

> **Why this is safe to enable.** Interception does not add a way *around* the
> fence — the request inside the tunnel is judged by the same rules as a
> plain-HTTP one, on the same socket the fence already owns. It closes the one
> hole the opaque-tunnel flag opened: with `EGRESS_ALLOW_TLS=1` and no
> interception, every rule in the table above stopped applying to anything sent
> over HTTPS.

## Verifying it

```bash
cd backend
pnpm exec tsx --test tests/egressFence.test.ts
```

The suite runs the fence as a real process on a real socket: an allowed request
is forwarded to an upstream and comes back 200, a `DELETE` and a
`POST /api/Users/1/delete` come back 403, an out-of-scope host comes back 403,
and a `CONNECT` tunnel is refused.

With TLS interception on, the same socket-level suite drives real `CONNECT`
tunnels: it stands up an HTTPS upstream signed by the fence's own CA, opens a
tunnel through the fence with a client that trusts that CA, and asserts that a
`GET` is forwarded and comes back 200 while a `DELETE` inside the same tunnel
comes back 403 — proving the plaintext request is judged by the same rules. It
also asserts a write to a public out-of-scope host is refused before the fence
dials anything, and that a private or unidentifiable host's `CONNECT` is refused
before a handshake is attempted.
