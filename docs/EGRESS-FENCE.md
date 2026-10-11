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
- `src/egressProxy.ts` — the process that calls it. Plain HTTP is fully judged;
  a `CONNECT` tunnel is refused, because a tunnel is opaque and a fence that
  lets one through is not a fence for what travels inside it.

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
| A request to a delete/disable endpoint (any method inside the engagement; any word in a path segment or query such as `/deleteUser`, `?action=remove`), a GraphQL mutation named `delete*`/`remove*`, a destructive SQL statement, or a sqlmap write flag does not leave | best effort — "this POST removes data" is a judgement about meaning, and a novel endpoint name will not be recognised |
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

### The browser agent needs the fence too

The browser does not run on the attack box — it runs in the **backend**
container (that is why the VNC stream is published on the backend's port 6080).
Network isolation cannot cover it, because the backend also needs Mongo, Redis
and the model API. It is covered by configuration instead: the browser already
accepts a proxy, so point it at the fence.

```bash
MAGNITUDE_PROXY_URL=http://egress:3128
```

Set it in the backend's `.env` (or under Settings → Browser agent). Leaving it
empty means browser traffic leaves the backend container directly and is judged
by nothing — the one hole the topology does not close by itself.

Set the allowlist from the engagement:

```bash
EGRESS_ALLOWLIST="$(host_from_session_target)" docker compose up -d egress
```

An unarmed fence refuses to start (`assertEgressProxyArmed`): with no declared
Target there is no allowlist, and serving every request uninspected would look
like a fence while being none.

## TLS

Refused by default. The box already trusts the Burp CA
(`services/burp-ca.service.ts` installs it), so terminating TLS at the fence and
re-signing with that CA is the path to inspecting HTTPS too — until then,
`EGRESS_ALLOW_TLS=1` opens tunnels that are **not** inspected, and the two 100%
rows in the table above stop applying to anything sent inside them.

## Verifying it

```bash
cd backend
pnpm exec tsx --test tests/egressFence.test.ts
```

The suite runs the fence as a real process on a real socket: an allowed request
is forwarded to an upstream and comes back 200, a `DELETE` and a
`POST /api/Users/1/delete` come back 403, an out-of-scope host comes back 403,
and a `CONNECT` tunnel is refused.
