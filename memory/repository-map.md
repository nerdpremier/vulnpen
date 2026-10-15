# VulnPen — Repository Map

VulnPen by T-NET IT Solution. AI assistant for OWASP WSTG v4.2 web app security testing. Agentic execution on Kali attack box, findings mapped to OWASP Top 10:2025, CVSS v3.0 base metrics.

## Top-Level Directories

- backend/ — Express + TS backend (port 8080), Mongo 7, Redis 7
- frontend/ — Next.js app (port 3000)
- kali/ — Kali attack box image + entrypoint
- kali-data/ — shared bind mount (workspaces, chromium profile)
- deploy/ — Caddy example
- docs/ — SETUP, benchmark/research notes
- .agents / .claude / .cursor / .freebuff / .zcode — tooling config

Key top-level files: README.md, PRODUCT.md, GLOSSARY.md, run.sh, docker-compose.yml, docker-compose.dev.yml, docker-compose.kali.yml, config.toml(.template), backend/.env(.template), frontend/.env(.template).

## Runtime Topology

Core stack (docker-compose.yml): mongodb, redis, backend, collabora (WOPI editor), frontend. All ports bind 127.0.0.1. `mongo-express` is defined here too but behind the `tools` profile, so a plain `up` never starts it (`docker compose --profile tools up -d mongo-express`).

Dev stack (docker-compose.dev.yml): infra + kali; host dev runs `pnpm run watch` + `pnpm run dev`, frontend dev. It defines a `backend` service that dev mode never starts (dev runs the backend on the host).

Kali stack: **an override of the core file**, not a standalone stack — `docker compose -f docker-compose.yml -f docker-compose.kali.yml`. It adds only what the attack box changes: the `kali` service, the internal `control` network, and the backend's kali wiring (SSH_HOST=kali, the BROWSER_AGENT_* set, BURP_RPC_HOST, the 9021 desktop bridge, the /kali-data mount, depends_on kali). Backend and attack box share `default` (internet) + internal `control`. Attack box egresses directly. Backend bridges attack box desktop to host, bundles Burp. The box publishes only 4242 (ssh) and 4200 (shellinabox) on loopback — its own 9020/noVNC and the 1194/udp OpenVPN-server port are not published; `run.sh` prepends the base file in `compose()`.

## Backend src (backend/src)

- server.ts — bootstrap (Mongo, Redis session store, migrations, run recovery)
- controllers/ — agent, auth, burp, magnitude, ssh, user, vnc, vpn, vulnerability, web-security, workspace
- routes/ — agent, auth, burp, shell, user, vnc, vpn, wopi, workspace
- middlewares/ — VerifySession, Multer
- models/ — User, Sessions (incl. vulnerabilities, test plan, runs), Workspace, HistoryArchive
- services/ — agent, agent.tools, context, compaction, session.lifecycle/helpers/transcript, ssh, vpn-profiles, burp-client/ca, browser-agent/view/dom/remote, capabilities, vulnerability, web-security/, host-owner, model-settings/catalog, subscription-inference, tool-approval, consent-batch, slash, engagement-state, shell.manager/socket/io, vnc-provisioning, work-host
- tools/handlers/ — run-bash, run-python-script, spawn/write/read/close-shell, magnitude-browser, view-image, send-to-burp, burp history/intruder/collaborator, wstg-test-plan, map-finding-owasp, generate-pentest-report, load-tools, run-install-tool, update-engagement-state, generic-response, list-shells
- utils/ — scopeGate, targetSafety, consentDetail, loadConfig, envWriter, getSecrets, registrationPolicy, sshConfig, tcpProbe
- services/web-security/ — test-plan, run-queue, owasp-mapping, report/report-docx/summary, client-report, docx-text, scan-results, session-plan-store, wopi
- capabilities/ — registry of security tools/python packages, detect-missing
- knowledge/ — wstg-v42, owasp-cwe-index, owasp-top10-2025, cvss, types
- config/constants.ts, migrations/

## Frontend (Next.js App Router)

Routes match PRODUCT.md: dashboard, workspace/[id], session/[id] (+ chat, test-plan, test-plan/[id], scans, scans/[run], vulnerabilities, vuln/[id], report, burp, gui). Components: agent, common (PageShell/PageHeader/PageState, ui kit), pages per screen, settings, layouts. services: agent/auth/burp/infra/user/websecurity/workspace. stores.

## Agent runtime

Session created per engagement. Agent streams over SSE, reads engagement state and tool registry (merged with deferred). Tool calls executed via agent.tools (readiness checkReady, describeSafety, consent). Pending consent persisted in Mongo. Consent outcomes tracked (prompts/approvals/denials/safetyBlocks/circuitOpens). SSE forwarding. Context compaction/token budget. Orchestrator resolves model provider (OpenAI/Anthropic/Google/Mistral/OAuth/Codex/Claude CLI). Reasoning effort via proxy.

## Security-Sensitive Seams

1. Auth: bcrypt, express-session in Redis, cookie sid, rate limit login/register, verifySess on most routes. Registration policy first account bootstrap; ALLOW_REGISTRATION thereafter.
2. Host owner: requireHostOwner, first User by _id. Gates models/SSH/safety/VNC/Burp/Magnitude/Swarm/subscription.
3. Tool modes: auto vs requires_consent. No auto_approve.
4. Safety gate command-text target: targetSafety detectDestructiveTargetAction — HTTP DELETE, destructive SQL, sqlmap os-shell/file-write, delete/disable endpoints, burp raw requests, browser destructive goals. kinds destructive_target/out_of_scope/dangerous. effectiveSafetyDetail: destructive_target survives disableSafetyProtections toggle; only other kinds muted. Consent required in all modes for destructive_target.
5. Out-of-scope: scopeGate extracts hosts from engagement Target/Scope, precise command host extraction. crossingHosts excludes public read-only recon. scopeAllowlistFromContext arms only on declaredTarget (Scope prose cannot). disableSafetyProtections mutes out_of_scope if true.
6. Burp CA trust: burp-ca.service fetches Burp CA into browser NSS profile.
7. Web limits: express.json 5mb, wopi 30mb, mongoSanitize, helmet (HSTS prod only, CORP same-site), CORS allowlist prod HTTPS.
8. Secrets: config.toml + backend/.env. Production enforces SESS_SECRET >=32, HTTPS CORS origins. llmProxy HMAC signature + timingSafeEqual, isAllowedProxyTarget blocks private hosts.
9. Consent tracking: ApprovalRejectionTracker circuit open at 3 consecutive or 10/50 denials; consent stats; PendingConsent persistence; consent-batch split.
10. Multer uploads, VNC/Burp password seeding, VNC passwd auth, Kali root password env. Kali mode cap_drop ALL + selective caps.
11. Agent state: resetStuckRunningSessions boot. Abort controllers per session.
12. WOPI authorized by access token (not session).
13. rateLimiter on login/register. requireActiveSession enforces uid/status.

## Docs

- docs/SETUP.md — install/config/recovery/deploy authoritative.
- docs/benchmark-wstg-juiceshop.md, browser-agent-diagnosis.md — research/maps.
- deploy/Caddyfile.example — reverse proxy template.
