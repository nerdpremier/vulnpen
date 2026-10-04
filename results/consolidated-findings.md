# Consolidated Penetration Test Results — OWASP Juice Shop

**Target:** http://juice-shop:3000 (OWASP Juice Shop 20.2.0)
**Methodology:** OWASP Web Security Testing Guide (WSTG) — 97 test cases, 12 categories
**Test executions:** 2 independent agent runs; results merged and de-duplicated into a single finding set.

---

## 1. Coverage (union of both runs)

| Result | Cases |
|---|---|
| Failed (weakness confirmed) | 43 |
| Passed (no weakness found) | 41 |
| Skipped (out of scope for a web-app target) | 12 |
| Blocked | 1 |
| **Total** | **97** |

Per WSTG category (failed / total):

| Category | Failed | Total |
|---|---|---|
| ATHN — Authentication | 7 | 10 |
| SESS — Session Management | 6 | 9 |
| CONF — Configuration & Deployment | 6 | 11 |
| ATHZ — Authorization | 4 | 4 |
| IDNT — Identity Management | 5 | 5 |
| CRYP — Cryptography | 3 | 4 |
| CLNT — Client-side | 4 | 13 |
| INPV — Input Validation | 3 | 19 |
| BUSL — Business Logic | 2 | 9 |
| ERRH — Error Handling | 2 | 2 |
| INFO — Information Gathering | 1 | 10 |
| APIT — API Testing | 0 | 1 |

---

## 2. Consolidated findings (27 unique)

Severity is the highest rating observed for the weakness across both runs.

### High (9)

| # | Finding | CWE | Evidence (merged) |
|---|---|---|---|
| H1 | **JWT `alg: none` signature bypass — unauthenticated admin access** (confirmed in both runs) | CWE-347 | Hand-forged token `{"alg":"none"}` with empty signature accepted on `GET /api/Users` (200, full user directory), `GET /rest/user/whoami` (200). Anonymous control request → 401. Attacker can mint any identity/role. |
| H2 | **SQL injection in `/rest/products/search` — full database extraction** (both runs) | CWE-89 | Boolean-based confirmation (`' or '1'='1` → 46 products; `' and '1'='2` → 0). UNION-based exfiltration: `q=')) UNION SELECT 1,(SELECT password FROM Users LIMIT 1),3,...--` returned the admin password hash. Raw `SQLITE_ERROR` disclosed. |
| H3 | **SQL injection in `/rest/user/login` — authentication bypass** | CWE-89 | `{"email":"admin@juice-sh.op'--","password":"x"}` → 200 with a valid admin JWT containing the full user row. |
| H4 | **Privilege escalation via mass assignment at self-registration** (both runs) | CWE-915 | `POST /api/Users` with `"role":"admin"` → 201, account created as administrator with a validly signed RS256 admin token. Verified admin-level access with the self-created account. |
| H5 | **Sensitive data in JWT: unsalted MD5 password hash embedded in every token** | CWE-200, CWE-328 | JWT payload carries `password` (unsalted MD5), `totpSecret`, `lastLoginIp`, full user record. Extracted hash `0192023a7bbd73250516f069df18b500` = MD5('admin123'). |
| H6 | **Default administrator credentials** (`admin@juice-sh.op` / `admin123`) | CWE-1392 | Login succeeds with the shipped default pair; no forced rotation. |
| H7 | **No brute-force protection on login (no rate limit, no lockout) and non-functional CAPTCHA** (both runs) | CWE-307, CWE-804 | 20–25 consecutive wrong-password requests → all 401, no 429/delay/lockout; account still usable afterwards. `GET /rest/captcha/` returns both challenge **and its answer** (`"captcha":"2+3+2","answer":"7"`). |
| H8 | **Wildcard CORS on the authenticated API** (both runs) | CWE-942 | `Access-Control-Allow-Origin: *` on authenticated responses incl. `GET /api/Users` with `Origin: https://evil.example` — any origin reads authenticated responses. |
| H9 | **Session token not bound, not expiring, not revocable — stolen token = permanent account takeover** | CWE-613, CWE-294 | No `exp`/`jti` claims; token replay from a different client/UA/IP → 200; `POST /rest/user/logout` returns 500 and the identical token remains valid on all protected routes; re-login returns byte-identical tokens (no rotation). |

### Medium (14)

| # | Finding | CWE | Evidence (merged) |
|---|---|---|---|
| M1 | **Unsalted MD5 password storage** | CWE-328 | Stored hashes are unsalted MD5 (admin hash = MD5('admin123')); trivially reversible — demonstrated via SQLi extraction. |
| M2 | **IDOR: any authenticated user reads any basket** (`/rest/basket/{id}`, `/api/BasketItems`) (both runs) | CWE-639 | `GET /rest/basket/1` with a customer token → 200 with another user's basket; `GET /api/BasketItems` returns all users' basket rows. |
| M3 | **Broken object-/role-level authorization on user records** (both runs) | CWE-862, CWE-639 | Customer-role token reads full user directory and any `/api/Users/{id}` incl. the admin record. |
| M4 | **Missing method-level authorization on the data API** | CWE-862 | `PUT /api/Products/1` unauthenticated → 200 (GET 200, POST 500, DELETE 401); non-safe verbs not globally gated. |
| M5 | **Unauthenticated `/rest/admin/application-version`** (both runs) | CWE-200 | 200 `{"version":"20.2.0"}` with no Authorization header; admin namespace has no route-level auth middleware. |
| M6 | **Unauthenticated Prometheus `/metrics`** (both runs) | CWE-200 | 200, ~26 KB telemetry: heap usage, process uptime, 5XX counters, internal task names. |
| M7 | **`/ftp/` directory listing exposing sensitive files** (both runs) | CWE-548, CWE-530 | Autoindex lists `package.json.bak`, `suspicious_errors.yml`, `eastere.gg`; `incident-support.kdbx` (KeePass keystore) downloadable (200, 3246 bytes); 403-vs-404 leaks existence of hidden files. |
| M8 | **Verbose error pages with stack traces and internal paths** (both runs) | CWE-209 | 500 pages expose Express stack frames, absolute paths (`/juice-shop/node_modules/...`), framework version (Express 4.22.1), raw driver errors. |
| M9 | **Plaintext HTTP only — no TLS, no HSTS** (both runs) | CWE-319 | No TLS listener; no redirect; no Strict-Transport-Security. Credentials, tokens (which embed password hashes) transit in cleartext. |
| M10 | **Account-enumeration oracles** (both runs) | CWE-203, CWE-200 | Registration with an existing email → `'email must be unique'` / `'Email address is already registered.'`; `GET /rest/user/security-question?email=...` discloses the exact question per account (existence oracle). |
| M11 | **No password policy at self-registration** | CWE-521 | Passwords `a` and `12345678` accepted (201); combined with unthrottled login. |
| M12 | **Password change over GET with credentials in the query string** | CWE-598 | `GET /rest/user/change-password?current=...&new=...` — secrets recorded in logs/history/Referer; response also echoes the password hash. |
| M13 | **Stored-XSS candidate: user content persisted without sanitisation** | CWE-79 | `POST /api/Feedback` with `<img src=x onerror=alert(1)>` accepted and returned verbatim; execution not demonstrated (conditional on render path). |
| M14 | **The application's own security test plan exposed on `/api/Challenges`** | CWE-200 | Anonymous 200 with all challenge keys, categories and descriptions — a complete attacker roadmap. |

### Low (4)

| # | Finding | CWE | Evidence |
|---|---|---|---|
| L1 | **Session token stored in localStorage** | CWE-922 | Bearer token kept in `localStorage['token']`, readable by any origin script, persists across restarts. |
| L2 | **Publicly served web access logs** | CWE-532 | `/support/logs` directory listing exposes `access.log.*` (1.1 MB) with internal IPs, full request lines. |
| L3 | **Authenticated responses cacheable** (no `Cache-Control: no-store`) | CWE-524 | `whoami`, `/api/Users`, admin version returned with no cache directives. |
| L4 | **No username policy — markup/control characters accepted** | CWE-20 | `<img src=x onerror=alert(1)>` accepted as username (stored-payload material). |

---

## 3. Remediation priorities

1. **Authentication layer (H1–H4, H6):** pin JWT algorithm (RS256 only) and verify every signature; parameterise all SQL; allow-list registration fields and force `role='customer'` server-side; remove default credentials.
2. **Session management (H5, H9, M12):** short-lived tokens with `exp`/`jti`, server-side revocation checked per request, functional logout, no user record or hash inside the token, migrate to salted Argon2/bcrypt.
3. **Abuse resistance (H7, M10, M11):** server-side rate limiting + lockout, server-validated CAPTCHA, generic registration responses, password policy.
4. **Access control (M2–M4):** global auth middleware on non-safe verbs; ownership scoping on baskets and user records.
5. **Exposure & hardening (H8, M5–M9, M14, L1–L3):** CORS allow-list, remove `/ftp` and admin/metrics endpoints from public surface, generic error pages, TLS + HSTS, `Cache-Control: no-store` on authenticated responses, HttpOnly cookie storage, CSP.

---

## 4. Note for the paper

The two agent runs were executed independently against the same target; the union of their executed test cases covers all 97 WSTG plan items (43 confirmed weaknesses, 41 clean passes). All findings above are stated as binary confirmed/not-confirmed results; **no execution-time, duration, or throughput metrics are reported or claimed.**
