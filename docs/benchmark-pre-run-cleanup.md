# Pre-benchmark cleanup — 2026-10-15

Record of the wipe performed before the next WSTG benchmark run. The point of this
document is provenance: it states what "test data" means on this deployment, where each
store lives, exactly what was removed, what was deliberately kept, and how the clean state
was verified. Keep it with the benchmark results.

Operator-confirmed scope. Backup taken first — see **Backup** below.

---

## 1. Where test data lives on this deployment

| # | Store | Physical location | What it holds |
|---|---|---|---|
| 1 | MongoDB `vulnpen` | container `vulnpen-mongodb`, named volume `projectz_mongodb-data` | `sessions` (runs), `workspaces`, `exploitboxes`, `historyarchives` (transcripts), `users` |
| 2 | MongoDB stray DBs | same volume | `backupcheck` / `backupfull` — created by exercising the backup feature |
| 3 | Redis | container `vulnpen-redis`, named volume `projectz_redis_data` | `agent:pause:*` flags, `sess:*` session store |
| 4 | Generated artefacts | container `vulnpen-backend`, named volume `projectz_backend-data` → `/srv/data` | `reports/` (`.docx` + `.meta.json`), `screenshots/`, `workspaces/` |
| 5 | Workspace scaffolding | host bind `./kali-data` → `/kali-data` | `workspaces/`, `vpn-profiles/`, `chromium-home/` (agent browser profile) |
| 6 | Host archives | `./backups/` | `mongodump` archives + an OWASP-migration JSON containing earlier findings |
| 7 | *(not a store)* | `config.toml [tracing] enabled = false`, no Langfuse container | tracing is off — no trace data exists anywhere |
| 8 | Benchmark target | container `vulnpen-juice-shop` (see §7) | **nothing persistent** — Juice Shop keeps all state in memory and declares no volume, so `down` + `up` yields a genuinely fresh target |

`admin` / `config` / `local` are MongoDB's own databases and are never touched.

## 2. Deleted

### MongoDB
| Target | Before | After |
|---|---:|---:|
| `vulnpen.sessions` | 0 | 0 *(already empty)* |
| `vulnpen.workspaces` | 0 | 0 *(already empty)* |
| `vulnpen.exploitboxes` | 0 | 0 *(already empty)* |
| `vulnpen.historyarchives` | 1 | **0** |
| `vulnpen.users` → `zverify@local.test` | 1 | **0** *(synthetic test account)* |
| database `backupcheck` | present | **dropped** |
| database `backupfull` | present | **dropped** |

### Redis
`FLUSHALL` — 13 keys → **0** (12 × `agent:pause:<uuid>` stale pause flags + 1 × `sess:<id>`).

### Files
| Path | Removed | Note |
|---|---|---|
| `/srv/data/reports/` | 24 files (288 KB) — 12 report pairs | directory kept, emptied |
| `/srv/data/screenshots/` | 24 files in 6 session dirs (3.1 MB) | directory kept, emptied |
| `/srv/data/workspaces/` | 1 directory | directory kept, emptied |
| `/srv/data/chromium-home/` | **entire 1.6 GB profile** | recreated empty; `chromium-home/.pki` was backed up first |
| `/kali-data/workspaces/` | 4 directories | directory kept, emptied |
| `./backups/owasp-migration-20261009-183853.json` | 199 KB | copied to backup, original deleted |
| `./backups/vulnpen-db-20261002.archive` | 1.0 MB | copied to backup, original deleted |
| `./backups/vulnpen-db-clean-20261002.archive` | 110 KB | copied to backup, original deleted |

**Space reclaimed:** `/srv/data` 1.65 GB → 152 KB.

## 3. Kept deliberately

| Item | Why |
|---|---|
| `vulnpen.users` → `admin@admin.com` | the operator's login. Verified intact: bcrypt hash present (60 chars), `configs`, `firstLogin` preserved |
| MongoDB `admin` / `config` / `local` | MongoDB internals |
| `/srv/data/.env`, `config.toml`, `model-registry.json` | configuration, not results |
| `/srv/data/burp-ca/` | Burp CA material — re-issuing it would invalidate trust set up elsewhere |
| `/kali-data/chromium-home/.pki/nssdb` | the agent browser's trust store, incl. the Burp CA. **Deleting this would silently break HTTPS interception through Burp** |
| `/kali-data/chromium-home` | the agent browser profile itself. Kept in the first pass; its *contents* were cleared afterwards in a second pass — see §6 |
| `/kali-data/vpn-profiles/` | empty; engagement VPN material lives here when configured |
| `/root/.BurpSuite/burpbrowser` (661 MB, container-local) | Burp's *bundled Chromium install*, not a user profile — inspected: no `Cookies`, `History` or `Local Storage` |
| `docs/benchmark-wstg-juiceshop.md` | the 2026-10-01 benchmark write-up |

## 4. Backup

```
backups/pre-benchmark-20261015-134220/
├── mongodb-all.archive          (316 KB)  mongodump --archive --gzip, ALL databases
├── redis.rdb                    (4 KB)    RDB snapshot
├── srv-data-evidence.tar.gz     (3.1 MB)  reports + screenshots + workspaces, 58 entries
├── kali-data-workspaces.tar.gz  (1 KB)    4 workspace dirs, 5 entries
├── chromium-home-pki.tar.gz     (4 KB)    .pki/nssdb — Burp CA trust, 5 entries
└── previous-backups/            (1.3 MB)  the 3 deleted ./backups files, as they were
```

All archives were verified readable after creation: `mongorestore --dryRun` exits 0 on the
Mongo archive, and every tarball was listed successfully.

Restore, if the wipe has to be undone:

```bash
# MongoDB (all databases, overwriting)
docker cp backups/pre-benchmark-20261015-134220/mongodb-all.archive vulnpen-mongodb:/tmp/r.archive
docker exec vulnpen-mongodb mongorestore --archive=/tmp/r.archive --gzip --drop

# Redis
docker cp backups/pre-benchmark-20261015-134220/redis.rdb vulnpen-redis:/data/dump.rdb
docker restart vulnpen-redis

# Generated artefacts
docker cp backups/pre-benchmark-20261015-134220/srv-data-evidence.tar.gz vulnpen-backend:/tmp/
docker exec vulnpen-backend tar -xzf /tmp/srv-data-evidence.tar.gz -C /srv/data

# Burp CA trust for the backend placeholder browser
docker cp backups/pre-benchmark-20261015-134220/chromium-home-pki.tar.gz vulnpen-backend:/tmp/
docker exec vulnpen-backend tar -xzf /tmp/chromium-home-pki.tar.gz -C /srv/data/chromium-home
```

## 5. Verification (after the wipe)

| Check | Result |
|---|---|
| MongoDB databases | `admin, config, local, vulnpen` — the two stray test DBs are gone |
| `vulnpen` collections | sessions 0, workspaces 0, exploitboxes 0, historyarchives 0, users 1 |
| `users` content | `[admin@admin.com]` only |
| Redis `DBSIZE` | 0 |
| `/srv/data/reports`, `screenshots`, `workspaces` | 0 entries each |
| `/srv/data` total | 152 KB (from 1.65 GB) |
| `/kali-data/workspaces` | 0 entries |
| `./backups/` | only `pre-benchmark-20261015-134220/` |
| Containers | mongodb, redis, collabora, backend, frontend, kali, mongo-express — all up, healthy |
| `GET /api/healthcheck` | 200 |
| Frontend `:3000` | 200 |
| `check:browser:remote` | **12/12 PASS** — SSH → Chromium on the box → CDP tunnel → DOM drive → clean stop |
| Admin account | bcrypt hash + config fields intact |

The backend container was restarted after the wipe so the fresh Chromium profile and the
empty session store are what the running process actually holds.

## 6. Cleared — residual browser state in the agent profile

`/kali-data/chromium-home/profile/` (the browser the agent drives) carried browsing state
from earlier pentest work. It was **kept** in the first pass because the operator's
confirmation covered the profile as a whole, not its contents. The operator then approved
clearing it. This section records what was found, what was removed, and the proof.

### 6.1 What was found

State stores, in `profile/Default/`:

| Store | Content |
|---|---|
| `Login Data` | 1 saved credential for `http://zero.webappsecurity.com:8080/` — a *previous test target* |
| `History` | 37 URLs / 86 visits, incl. `http://zero.webappsecurity.com:8080/login.html?login_error=true` and `.../apache-version-probe-nonexistent` |
| `Cookies` | 19 entries, all `google.com` / `youtube.com` — **no target cookies** |
| `Web Data` | 5 autofill rows |
| `Top Sites` | 10 rows |

Three stores that were **not** in the original brief but did hold target data, found by
grepping the whole profile for the target hostname:

| Store | Why it mattered |
|---|---|
| `profile/segmentation_platform/ukm_db` | **URL-Keyed Metrics — a full plaintext log of every URL visited**, including `login.html?login_error=true`, `search.html?searchTerm=admin`, `robots.txt`, `sitemap.xml`, `/admin/users.html` and a `site:zero.webappsecurity.com` search. The single worst offender. |
| `Default/Cache/Cache_Data` (25 files) | cached response bodies from the target |
| `Default/Code Cache/js` (8 files) | compiled JS from the target |
| `Default/Preferences` | 8 `profile.content_settings.exceptions` keys for `webappsecurity.com` (cookie controls, media/site engagement) |

The initial assumption that the HTTP cache is "performance only, not browsing history" was
**wrong** — 38 files across the profile named the target hostname. The `ukm_db` URL log in
particular would have leaked the entire previous session's navigation into a benchmark run
whose integrity is being claimed in a paper.

### 6.2 What was removed

Two passes, both run with Chromium stopped (the script refuses to run otherwise, since a
live browser rewrites its state on shutdown).

Pass 1 — user/origin data, in `profile/Default/`:

- credential & history stores: `Cookies`, `History`, `Login Data`, `Login Data For Account`,
  `Web Data`, `Account Web Data`, `Affiliation Database`, `Top Sites`, `Shortcuts`,
  `Favicons` (each with its `-journal`)
- network/site traces: `Network Action Predictor`, `Network Persistent State`,
  `TransportSecurity` (HSTS hosts), `DIPS`, `Reporting and NEL`, `MediaDeviceSalts`,
  `Trust Tokens`, `SharedStorage`, `Safe Browsing Cookies`, `ServerCertificate`,
  `heavy_ad_intervention_opt_out.db`, `SCT Auditing Pending Reports`
- origin storage: `Local Storage/`, `Session Storage/`, `Sessions/`, `IndexedDB/`,
  `WebStorage/`, `shared_proto_db/`, `blob_storage/`
- regenerable site/feature DBs: `chrome_cart_db`, `commerce_subscription_db`,
  `discount_infos_db`, `discounts_db`, `parcel_tracking_db`,
  `optimization_guide_hint_cache_store`, `BudgetDatabase`, `ClientCertificates`,
  `Site Characteristics Database`, `VideoDecodeStats`, `GCM Store`, `Download Service`,
  `Feature Engagement Tracker`, `Segmentation Platform`, `Sync Data`, `Extension State`

Pass 2 — the residue found by grep:

- `Default/Cache/`, `Default/Code Cache/`, `Default/GPUCache/`, `Default/Shared Dictionary/`,
  `Default/Service Worker/`
- 39 `Default/.org.chromium.Chromium.*` scratch files
- `profile/segmentation_platform/` (the `ukm_db` URL log)
- the 8 `webappsecurity.com` keys scrubbed out of `Default/Preferences` via a JSON rewrite
  (the file itself is kept, so browser settings survive)

### 6.3 Kept deliberately

| Path | Reason |
|---|---|
| `chromium-home/.pki/nssdb/` | the **Burp CA trust store** — deleting it silently breaks HTTPS interception. Verified byte-identical before and after (§6.4). |
| `Default/Preferences`, `Secure Preferences` | browser settings; the 8 target-origin keys inside were removed instead of the file |
| `profile/Local State` | browser-level state, no target data |

### 6.4 Proof

Burp CA store, unchanged across the whole operation:

```
0febe3023fd8379535c28f0116ddfeb0af5d52ee29c1e8fd6a7667db081f334b  cert9.db
1b67a7974554dd0a865a91e51e974816b54fd04a55bd81a6be3bd52ef77e7887  key4.db
241a5c2e4667101c703a940b6b5cb9c681e5c7b940c59902ea612f51199ab646  pkcs11.txt
certs: 2
```

| Check | Before | After |
|---|---|---|
| files naming `webappsecurity` (whole `chromium-home`) | 38 | **0** |
| `Cookies` rows | 19 | 0 |
| `History` rows | 37 | 0 |
| `Login Data` rows | 1 | 0 |
| profile size | 203 MB | 122 MB |
| `check:browser:remote` | 12/12 PASS | **12/12 PASS** (re-run after the scrub) |

The check was re-run *after* the `Preferences` rewrite specifically to prove the profile
still launches, attaches over CDP, drives the DOM and stops cleanly.

Two benign rows remain, both created by the verification run itself, not by prior test work:
`Top Sites` holds Chromium's default `chrome.google.com/webstore` NTP tile, and `Web Data`
holds `user=operator` from the check script's fill action. History and cookies are empty.

**A third pass was needed afterwards.** Standing the benchmark target up (§7) was verified
end-to-end with `check:browser:live` pointed at `http://juice-shop:3000`, and that run wrote
56 files naming `juice-shop` back into the profile — cache, `segmentation_platform/ukm_db`,
`DIPS-wal`, `Session Storage/`, `Sessions/` and two `Preferences` content-settings keys. It
was cleaned with the same pass-2 procedure. Notably `History` and `Cookies` stayed at 0 rows
throughout, because `killRemoteChromium()` ends the browser hard enough that neither store is
flushed to disk — so a zero row count is **not** evidence that the profile is clean. Only the
grep is. Final state: 0 files matching `juice-shop`, `webappsecurity`, `127.0.0.1:4000` or
`localhost:3000`, with the Burp CA store still byte-identical.

### 6.5 Backup

The pre-clear state is in
`backups/pre-benchmark-20261015-134220/agent-browser-profile-state.tar.gz`
(1,656,490 bytes, 374 entries) — `profile/` + `.pki/` + `.config`, with regenerable caches
excluded. Restore with:

```bash
docker cp backups/pre-benchmark-20261015-134220/agent-browser-profile-state.tar.gz vulnpen-kali:/tmp/
docker exec vulnpen-kali tar -xzf /tmp/agent-browser-profile-state.tar.gz -C /kali-data/chromium-home
```

## 7. Benchmark target — Juice Shop stood up

The target did not exist in any form when the wipe finished: no container, running or
stopped, and no image. `docs/benchmark-wstg-juiceshop.md` §8 had said
`docker compose up -d   # … juice-shop`, but that had been stale since commit `e9490e0`
removed the service from `docker-compose.yml` when Collabora took that slot.

### 7.1 Why a separate compose file

Juice Shop is the thing *being tested*, not part of the product, so it now lives in
**`docker-compose.target.yml`** instead of being restored to `docker-compose.yml`. Putting it
back in the product file would make every ordinary `docker compose up -d` start a
deliberately vulnerable app, and would ship the target with any deployment.

| Decision | Value | Why |
|---|---|---|
| Image | `bkimminich/juice-shop:v20.2.0` | pinned, not `latest` — the document reports v20.2.0 and the recorded evidence shows `/rest/admin/application-version` → `20.2.0`. `latest` would drift and make the claim unreproducible. |
| Host port | `127.0.0.1:4000:3000` | loopback only. The target is intentionally vulnerable and must not be on a routable interface. Matches the recorded run's host-side check. |
| Network | `projectz_default`, `external: true` | how the agent reaches it: the backend and the Kali attack box resolve `juice-shop` by name. `external` stops Compose creating a second, differently-named network. |
| Volume | none | Juice Shop holds all state in memory, so `down` + `up` gives a genuinely fresh target — which is what a repeatable benchmark needs. |
| Healthcheck | `/nodejs/bin/node -e …` (absolute path) | see §7.3. |

### 7.2 The `--remove-orphans` trap

`docker compose -f docker-compose.target.yml up -d` prints an orphan warning naming the
backend, the attack box, MongoDB and the rest. That is expected — they belong to the same
`projectz` project but are absent from this file.

**Never add `--remove-orphans` to that command.** Compose would treat the entire real stack as
orphaned and tear it down. The warning is documented in the file itself so the next person
does not "clean it up".

### 7.3 The image is distroless — the healthcheck had to be an absolute path

The first healthcheck used `["CMD", "node", "-e", …]` and the container sat at
`health: starting` forever with a failing streak of 11. The cause:

```
OCI runtime exec failed: exec: "node": executable file not found in $PATH
```

`bkimminich/juice-shop:v20.2.0` ships **no shell and no `curl`/`wget`**, and its runtime is at
`/nodejs/bin/node` — *not* on `PATH` (its own Entrypoint is `["/nodejs/bin/node"]`, Cmd
`["/juice-shop/build/app.js"]`, user `65532`). Two consequences:

- the healthcheck must call `/nodejs/bin/node` directly, in exec form (no `sh -c`);
- `docker exec vulnpen-juice-shop sh -c …` is impossible — the target can only be inspected
  from outside (host `curl`, or another container on the network).

### 7.4 Verification

| Check | Result |
|---|---|
| `docker inspect … .State.Health.Status` | `healthy`, failing streak 0 |
| `curl http://127.0.0.1:4000` | 200 |
| `/rest/admin/application-version` | `{"version":"20.2.0"}` — matches the documented run |
| `docker port vulnpen-juice-shop` | `3000/tcp -> 127.0.0.1:4000` — loopback only |
| from **backend**: `http://juice-shop:3000/…` | `{"version":"20.2.0"}` |
| from **kali** (attack box): `http://juice-shop:3000/…` | HTTP 200, `{"version":"20.2.0"}` |
| `check:browser:live` with `BROWSER_CHECK_URL=http://juice-shop:3000` | **PASS** — *"page read through the DOM path: OWASP Juice Shop — 47 interactive elements, 2013 chars of text"* |

That last row is the real proof: a Chromium on the attack box reached the target **through
Burp** and the DOM snapshot came back with genuine Juice Shop content. It exercises the exact
path a benchmark run uses — browser on the box → `MAGNITUDE_PROXY_URL` (Burp) → target.

The stack is now 8 containers: mongodb, redis, mongo-express, collabora, backend, frontend,
kali, juice-shop — all up, the healthy ones reporting healthy, with `/api/healthcheck` and the
frontend both returning 200.

