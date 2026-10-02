# VulnPen Autonomous Penetration Test — Benchmark Results

**Target:** OWASP Juice Shop v20.2.0 (`vulnpen-juice-shop`, served at `http://juice-shop:3000`)
**Framework:** OWASP Web Security Testing Guide (WSTG) v4.2 — full catalogue
**Run date:** 2026-10-01 (UTC)
**Operator:** VulnPen AI agent (autonomous, tool-assisted), human supervision only

This document records the complete results of a full WSTG v4.2 benchmark run against
OWASP Juice Shop, intended as the primary evidence set for the project paper.

> **Historical record.** This run predates the risk-matrix rework: findings were
> rated with a CVSS score and a "critical" severity level, both of which have since
> been removed from the platform (severity is now derived from the likelihood x
> impact risk matrix). The numbers below are kept as recorded on the run date.

---

## 1. Environment

| Component | Detail |
|---|---|
| Platform under test | VulnPen — autonomous AI pentest platform (orchestrator agent + browser agent + Kali toolchain) |
| Target application | OWASP Juice Shop v20.2.0, Docker container, single service, plain HTTP |
| Target exposure | Only port 3000 reachable from the test network (verified by a 40-port TCP connect sweep) |
| Test framework | WSTG v4.2 — 97 applicable cases after catalogue curation |
| Tools used by the agent | nmap, nuclei, curl, run_python_script (custom exploit scripts), browser agent (headed Chromium) |
| Session duration | ~3 h 50 min total (plan generation 03:49–03:51 UTC, testing 03:51–06:42 UTC, report/review to 07:41 UTC) |

## 2. Methodology

1. **Plan generation.** The agent generated a WSTG v4.2 test plan covering all 12 WSTG
   categories. Cases that do not apply to the target are retained but expected to end
   `blocked`, never silently dropped — coverage is measured against the executed set.
2. **Case execution.** Each case was executed autonomously: the agent chooses tools,
   runs them, records raw observations and a verdict per case. A case `passed` means the
   security control was verified present; `failed` means the control failed (i.e. a
   vulnerability); `blocked` means the case is not applicable to this target (e.g. no
   TLS listener exists to test).
3. **Finding lifecycle.** Every failed case must link to a recorded finding
   (severity, CVSS, evidence, reproduction steps). Duplicate findings are merged to the
   existing one instead of being re-recorded, and duplicate *cases* cannot be added to
   inflate coverage.
4. **Verification.** Findings labelled *exploited* were confirmed with a working
   exploit (not just a suspicious response). A post-run review re-verified the critical
   findings and removed placeholder/duplicate records before final tallying.

## 3. Coverage Summary

**97/97 cases executed (100%). 41 passed, 55 failed, 1 blocked.**

| WSTG Category | Cases | Passed | Failed | Blocked |
|---|---:|---:|---:|---:|
| INFO — Information Gathering | 10 | 10 | 0 | 0 |
| CONF — Configuration & Deployment Mgmt | 11 | 6 | 5 | 0 |
| IDNT — Identity Management | 5 | 1 | 4 | 0 |
| ATHN — Authentication | 10 | 0 | 10 | 0 |
| ATHZ — Authorization | 4 | 1 | 3 | 0 |
| SESS — Session Management | 9 | 0 | 9 | 0 |
| INPV — Input Validation | 19 | 15 | 4 | 0 |
| ERRH — Error Handling | 2 | 0 | 2 | 0 |
| CRYP — Cryptography | 4 | 1 | 2 | 1 |
| BUSL — Business Logic | 9 | 0 | 9 | 0 |
| CLNT — Client-side Testing | 13 | 6 | 7 | 0 |
| APIT — API Testing | 1 | 1 | 0 | 0 |
| **Total** | **97** | **41** | **55** | **1** |

Interpretation notes (useful for the paper's discussion section):

- **ATHN, SESS, BUSL scored 0% pass** — Juice Shop deliberately ships weak
  authentication/session/logic controls, and the agent found essentially all of them.
- **INPV 15/19 pass** — the agent did not claim SQLi/XSS everywhere; it correctly
  cleared 15 input-validation controls and failed only the 4 genuinely injectable ones.
- The single blocked case is **WSTG-CRYP-01** (Test for Weak Transport Encryption):
  the case presupposes a TLS listener to attack; the target serves plain HTTP only, so
  the exposure is recorded once as a high-severity transport finding instead of a
  synthetic test result.

## 4. Findings

**45 findings recorded — 4 critical, 16 high, 21 medium, 4 low. 40 of 45 (89%) were
confirmed exploited, not merely suspected.**

After deduplication review, 45 records correspond to 43 distinct issues
(one transport/crypto finding pair and one JWT finding pair were recorded twice during
verification passes and are counted once each in the discussion below).

### OWASP Top 10 (2025) mapping

Mapping uses the system's OWASP Top 10:2025 knowledge base
(`backend/src/knowledge/owasp-top10-2025.ts`), which mirrors the published 2025
list — note the 2025 ordering differs from 2021: SSRF is folded into A01, and
A10 is now Mishandling of Exceptional Conditions, not SSRF.

| OWASP 2025 Category | Findings |
|---|---:|
| A01:2025 Broken Access Control | 7 |
| A02:2025 Security Misconfiguration | 10 |
| A04:2025 Cryptographic Failures | 2 |
| A05:2025 Injection | 2 |
| A06:2025 Insecure Design | 4 |
| A07:2025 Authentication Failures | 17 |
| A09:2025 Security Logging and Alerting Failures | 1 |
| A10:2025 Mishandling of Exceptional Conditions | 2 |
| (not yet mapped) | 8 |

### Critical findings (exploited, with evidence)

| # | Finding | WSTG | CVSS | Evidence summary |
|---|---|---|---|---|
| 1 | Unauthenticated admin account registration → full takeover | WSTG-ATHZ-03 | 9.8 | `POST /api/Users` with `"role":"admin"` returned 201; the new account logged in and received an admin JWT granting `/api/Users`, `/api/Complaints`, `/rest/admin/...` |
| 2 | SQL injection in login → auth bypass + admin takeover | WSTG-INPV-05 | 9.8 | `{"email":"' OR 1=1--"}` returned 200 with an admin JWT; the same password against the real admin returned 401, proving injection, not a valid credential |
| 3 | JWT `alg: none` signature bypass → identity forgery | WSTG-ATHN-04 | 9.8 | Unsigned token (`alg:none`, empty signature) accepted on admin routes; `GET /api/Users` → 200 full user table; `DELETE /api/Users/1` → 200 (destructive verification) |

### Representative high findings

- IDOR: any authenticated customer can read any user's basket via `/rest/basket/{id}`;
  basket item quantity tampering via `PUT /api/BasketItems/{id}`
- Broken function-level authorization: any customer can tamper with product catalogue
  and prices
- Sensitive-data exposure: full user enumeration incl. PII via `/api/Users`; password
  hashes embedded in JWT; unsalted MD5 hashes enabling offline cracking
- Missing cryptographic key material served unauthenticated at `/encryptionkeys`
  (incl. KeePass database under `/ftp`)
- Wildcard CORS policy allowing cross-origin authenticated API access with
  state-changing methods
- CSRF on a GET-based password-change endpoint
- DOM-based XSS via Angular `bypassSecurityTrustHtml` on the search parameter
- No transport encryption at all (plain HTTP, no TLS listener, no HSTS)

### Representative medium findings

- `/ftp` directory listing with sensitive internal documents unauthenticated
- No session invalidation on logout (stateless JWT, no `exp`, no `jti`, no revocation)
- CAPTCHA solution disclosed in plaintext; feedback endpoints unauthenticated
- `/rest/saveLoginIp` echoes the caller's full user record including password hash and
  TOTP secret
- 2FA secret and setup token disclosed by `/rest/2fa/status`
- Mass assignment on registration (attacker-chosen primary key and internal fields)
- Server-side upload allow-list not enforced (executable content accepted)
- No rate limiting / abuse detection: 25 accounts registered in 0.8 s
- No password policy: accounts created with empty or one-character passwords
- Verbose stack traces and raw SQLite driver errors on unauthenticated endpoints
- Unauthenticated Swagger UI / full OpenAPI 3.0 spec at `/api-docs`
- Free deluxe-membership upgrade via `POST /rest/deluxe-membership` without payment
- Session cookie written by client JS with no `HttpOnly`, no `Secure`, no `SameSite`

## 5. Timeline

| Time (UTC) | Milestone |
|---|---|
| 03:49 | Session started |
| 03:51 | WSTG v4.2 plan generated (97 cases) |
| 03:53 | First finding recorded |
| 06:25 | Last finding recorded (main testing phase ≈ 2 h 34 min) |
| 06:42 | Final case status updated — 97/97 executed |
| 07:41 | Report generation and review complete |

## 6. Benchmark Integrity Controls

These controls were added after an internal audit of the run and are part of the
platform's methodology going forward:

1. **No fabricated coverage.** The agent cannot add custom cases that duplicate
   catalogue cases (duplicate detection by significant-token overlap, stricter within
   the same WSTG category). An earlier run's coverage of "99/99" was corrected to the
   real 97-case catalogue.
2. **Append-only findings with removal tooling.** Findings can only be removed via an
   explicit `remove_finding` action, so placeholder or superseded records are deleted
   rather than silently edited; duplicate failed cases link to the existing finding
   instead of creating a second one.
3. **Blocked ≠ passed.** Cases that cannot apply to the target are recorded `blocked`
   with the reason, never counted as passes.
4. **Exploitation requirement.** A severity claim is backed by evidence; 89% of
   findings in this run were confirmed by working exploits.

## 7. Known Limitations of the Run

- **No TLS listener on the target**, so WSTG-CRYP-01 (transport encryption strength)
  is structurally untestable and recorded blocked; the plain-HTTP exposure is captured
  as a single high finding. Enabling TLS on the Juice Shop container would make this
  case executable.
- **LLM-backed challenges not solved.** Juice Shop's AI/LLM challenges require a
  backend LLM endpoint (e.g. Ollama at `localhost:11434` + `ALCHEMY_API_KEY`); without
  it, a small number of BUSL/CLNT cases pass only at the control level rather than
  exercising the challenge's full logic.
- **Two duplicate finding records** were produced across verification passes
  (unsalted-MD5 finding, JWT `alg:none` re-verification). They are identified above and
  excluded from the unique-issue count; the platform's dedup guard now blocks this
  pattern.
- **Single-seed run.** Results are from one run with one model configuration; the
  paper should state variance across repeated runs / models as future work.

## 8. Reproducing

```bash
# stack
docker compose up -d                      # mongodb, redis, backend, kali, juice-shop
# target check
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4000   # 200

# source session (read-only evidence):
#   MongoDB vulnpen.sessions._id = 6abdd84b21425f4984101ada
#   webAppTestPlan.cases (97) + vulnerabilities (45) hold per-case observations
#   and full evidence/steps-to-reproduce for every finding
```
