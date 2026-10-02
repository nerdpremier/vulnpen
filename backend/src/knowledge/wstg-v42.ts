/**
 * OWASP Web Security Testing Guide v4.2 catalogue - static reference data.
 *
 * This mirrors the stable 4.2 release of the guide (the "stable" branch of
 * https://github.com/OWASP/wstg, source 4.2 tag) rather than the current
 * development branch, so ids, section numbers and titles stay reproducible for
 * reports and re-tests. The `id` field is the canonical WSTG identifier
 * (e.g. "WSTG-INPV-05"); `section` is the guide's own chapter numbering
 * (e.g. "4.7.5"). v4.2 ends at 4.12.1 Testing GraphQL: there is no REST API and
 * no WebAssembly test in this release, so none is invented here.
 *
 * The `owasp` field on each test is NOT published by OWASP: it is this project''s
 * curated WSTG-to-Top-10:2025 crosswalk (see knowledge/provenance.ts), derived
 * from the CWE lists OWASP publishes per category. The ids, sections and titles
 * of the test cases themselves are official WSTG v4.2 facts.
 *
 * The catalogs are plain compile-time data: no I/O, no side effects.
 */

import type { WstgCategory, WstgTest } from "./types";

export const WSTG_VERSION = "4.2";
export const WSTG_SOURCE = "https://github.com/OWASP/wstg";

/** The twelve WSTG v4.2 categories, in section order. */
export const WSTG_CATEGORIES: WstgCategory[] = [
  {
    code: "INFO",
    section: "4.1",
    name: "Information Gathering",
    objective:
      "Build a complete, evidence-backed picture of the target's servers, applications, entry points and architecture before any active attack.",
  },
  {
    code: "CONF",
    section: "4.2",
    name: "Configuration and Deployment Management Testing",
    objective:
      "Prove that the platform, deployment and infrastructure configuration is hardened and exposes no unintended services, files or administrative surfaces.",
  },
  {
    code: "IDNT",
    section: "4.3",
    name: "Identity Management Testing",
    objective:
      "Prove that identities, roles and provisioning are defined, separated and enforced exactly as the business intends.",
  },
  {
    code: "ATHN",
    section: "4.4",
    name: "Authentication Testing",
    objective:
      "Prove that authentication cannot be bypassed, guessed, replayed or performed more weakly through any supported channel.",
  },
  {
    code: "ATHZ",
    section: "4.5",
    name: "Authorization Testing",
    objective:
      "Prove that every request is authorised for the calling identity, so no user can read or change data they do not own.",
  },
  {
    code: "SESS",
    section: "4.6",
    name: "Session Management Testing",
    objective:
      "Prove that session state is unguessable, correctly scoped and invalidated when the user or the policy expects it.",
  },
  {
    code: "INPV",
    section: "4.7",
    name: "Input Validation Testing",
    objective:
      "Prove that untrusted input can never alter the application's control flow, queries, commands or rendered output.",
  },
  {
    code: "ERRH",
    section: "4.8",
    name: "Testing for Error Handling",
    objective:
      "Prove that failures are handled, logged and reported without disclosing internal detail or corrupting application state.",
  },
  {
    code: "CRYP",
    section: "4.9",
    name: "Testing for Weak Cryptography",
    objective:
      "Prove that data is protected in transit and at rest with sound, current cryptography and correctly managed keys.",
  },
  {
    code: "BUSL",
    section: "4.10",
    name: "Business Logic Testing",
    objective:
      "Prove that business rules, workflows and limits still hold when the client is untrusted.",
  },
  {
    code: "CLNT",
    section: "4.11",
    name: "Client-side Testing",
    objective:
      "Prove that the code and data delivered to the browser cannot be turned against the user or the application.",
  },
  {
    code: "APIT",
    section: "4.12",
    name: "API Testing",
    objective:
      "Prove that the API surface enforces the same authentication, authorisation and resource limits as the web interface.",
  },
];/** The 97 WSTG v4.2 test cases, in section order. */
export const WSTG_TESTS: WstgTest[] = [
  {
    id: "WSTG-INFO-01",
    section: "4.1.1",
    category: "INFO",
    title: "Conduct Search Engine Discovery Reconnaissance for Information Leakage",
    objective:
      "Prove that search engines, caches and public archives expose sensitive pages, documents or credentials the site never meant to publish.",
    howToTest:
      "Run dork queries (site:, intitle:, inurl:, filetype:, cache:) against the target domain on Google, Bing and DuckDuckGo, then repeat against non-search engines: Wayback Machine, Google/Bing cache and archive/history services. Open every interesting hit and check whether the resource is still live instead of cached.",
    owasp: ["A02:2025", "A01:2025"],
    cwe: ["CWE-200", "CWE-538"],
    tools: ["browser_action", "curl", "jq"],
    evidence: "Screenshot or saved request/response for each leaked artefact, together with the exact query that surfaced it.",
  },
  {
    id: "WSTG-INFO-02",
    section: "4.1.2",
    category: "INFO",
    title: "Fingerprint Web Server",
    objective:
      "Identify the web server product, version and patch level so known-vulnerable server software can be targeted precisely.",
    howToTest:
      "Send a baseline request with curl and inspect Server, X-Powered-By and Via headers plus header ordering; cross-check version findings with nmap -sV and the http-headers / http-server-header Nuclei templates. Where banners are stripped, trigger distinctive behaviour with malformed requests, oversized headers and unusual methods.",
    owasp: ["A03:2025", "A02:2025"],
    cwe: ["CWE-200", "CWE-1104"],
    tools: ["curl", "nmap", "nuclei", "search_burp_proxy_history"],
    evidence: "The response headers, error page or nmap output showing the server banner, kept with the raw request that produced it.",
  },
  {
    id: "WSTG-INFO-03",
    section: "4.1.3",
    category: "INFO",
    title: "Review Webserver Metafiles for Information Leakage",
    objective:
      "Prove that metafiles such as robots.txt, sitemap.xml and security.txt disclose hidden paths or sensitive functionality.",
    howToTest:
      "Fetch /robots.txt, /sitemap.xml, /security.txt, /.well-known/security.txt, /crossdomain.xml, /clientaccesspolicy.xml and CMS-specific files such as CHANGELOG.txt or readme.html. Enumerate every entry they expose and request each one directly to see whether it is really protected or merely unlinked.",
    owasp: ["A01:2025", "A02:2025"],
    cwe: ["CWE-200", "CWE-538"],
    tools: ["curl", "ffuf", "browser_action", "jq"],
    evidence: "The metafile contents plus a request/response pair for each path it revealed, marked as reachable without authorisation or not.",
  },
  {
    id: "WSTG-INFO-04",
    section: "4.1.4",
    category: "INFO",
    title: "Enumerate Applications on Webserver",
    objective:
      "Discover every application, virtual host and non-standard port served by the target so nothing is tested out of scope.",
    howToTest:
      "Brute-force virtual hosts and Host header names with ffuf using DNS and certificate-transparency names, compare answers with and without a matching Host header, then scan for web services on non-standard ports with nmap. Confirm each hit with a distinctive title, body or server response.",
    owasp: ["A01:2025", "A02:2025"],
    cwe: ["CWE-200", "CWE-668"],
    tools: ["ffuf", "nmap", "curl", "search_burp_proxy_history"],
    evidence: "List of discovered hostnames and ports, each with the response fingerprint that proves the application exists.",
  },
  {
    id: "WSTG-INFO-05",
    section: "4.1.5",
    category: "INFO",
    title: "Review Webpage Content for Information Leakage",
    objective:
      "Prove that delivered HTML, JavaScript and metadata leak comments, credentials, internal hostnames or developer notes.",
    howToTest:
      "Crawl the site while the proxy records, then grep every response for comment markers, API keys, e-mail addresses, internal IPs, TODO/FIXME notes, database errors and hidden form fields. Diff authenticated against unauthenticated responses for fields that should never be delivered.",
    owasp: ["A02:2025", "A01:2025"],
    cwe: ["CWE-200", "CWE-540", "CWE-615"],
    tools: ["search_burp_proxy_history", "curl", "run_python_script", "browser_action"],
    evidence: "The exact response fragment or devtools screenshot containing the leaked value, with its URL and account context.",
  },
  {
    id: "WSTG-INFO-06",
    section: "4.1.6",
    category: "INFO",
    title: "Identify Application Entry Points",
    objective:
      "Build a complete inventory of the requests, parameters, headers and cookies a client can control before adversarial testing begins.",
    howToTest:
      "Exercise every workflow in the browser with the proxy recording, then mine the proxy history for URLs, query strings, POST bodies, JSON keys, custom headers, cookies and WebSocket frames. Use ffuf for hidden parameters and check API/mobile clients for entry points the web UI never calls.",
    owasp: ["A02:2025", "A01:2025"],
    cwe: ["CWE-1059"],
    tools: ["search_burp_proxy_history", "browser_action", "ffuf", "jq"],
    evidence: "An entry-point table (method, URL, parameter, type, authentication required) exported from the recorded proxy history.",
  },
  {
    id: "WSTG-INFO-07",
    section: "4.1.7",
    category: "INFO",
    title: "Map Execution Paths Through Application",
    objective:
      "Prove that every reachable code path, including error, redirect and forced-browsing branches, has been visited and mapped.",
    howToTest:
      "Crawl with a valid session so the spider follows worked flows, then deliberately explore conditional branches: multi-step forms, error pages, redirects and direct requests to guarded links. Compare the reachable URL set against the sitemap to find paths that were never exercised.",
    owasp: ["A02:2025", "A01:2025"],
    cwe: ["CWE-1059"],
    tools: ["browser_action", "search_burp_proxy_history", "ffuf", "run_python_script"],
    evidence: "The application map (URL graph or sitemap) annotated with the request that reached each branch.",
  },  {
    id: "WSTG-INFO-08",
    section: "4.1.8",
    category: "INFO",
    title: "Fingerprint Web Application Framework",
    objective:
      "Identify the web framework, its version and its enabled modules so framework-specific vulnerabilities can be tested.",
    howToTest:
      "Inspect cookie names, HTML/JS artefacts, meta generator tags, error signatures, favicon hash and default file paths (/wp-login.php, /actuator, /server-status), and confirm with Nuclei framework-detection templates. Map the detected version against known CVEs before moving on.",
    owasp: ["A03:2025", "A02:2025"],
    cwe: ["CWE-200", "CWE-1104"],
    tools: ["nuclei", "browser_action", "curl", "jq"],
    evidence: "The fingerprint artefacts (cookie names, file paths, generator tags) with the detected product and version recorded.",
  },
  {
    id: "WSTG-INFO-09",
    section: "4.1.9",
    category: "INFO",
    title: "Fingerprint Web Application",
    objective:
      "Identify the concrete application build, its plug-ins and third-party components so component-level risk can be assessed.",
    howToTest:
      "Establish the application identity from titles, headers, JS bundles and file paths, then enumerate components: CMS plug-ins and themes, JavaScript libraries and their versions, and changelog or readme files that reveal release numbers. Map each component version to known vulnerabilities.",
    owasp: ["A03:2025", "A02:2025"],
    cwe: ["CWE-1104", "CWE-200"],
    tools: ["nuclei", "ffuf", "browser_action"],
    evidence: "A component table (product, version, source file) with the request/response or file that proves each version.",
  },
  {
    id: "WSTG-INFO-10",
    section: "4.1.10",
    category: "INFO",
    title: "Map Application Architecture",
    objective:
      "Prove the application's edge, proxies, WAF and backend topology are understood well enough to plan focused attacks.",
    howToTest:
      "Compare responses across repeated requests to spot load balancers and WAFs, map the edge with DNS, certificate transparency and nmap, and harvest backend hostnames, internal IPs and third-party endpoints from responses and JS. Probe the front-end/back-end boundary with host-header, path-normalisation and direct-IP requests.",
    owasp: ["A02:2025", "A01:2025"],
    cwe: ["CWE-1059", "CWE-200"],
    tools: ["nmap", "curl", "search_burp_proxy_history", "browser_action"],
    evidence: "An architecture note or diagram listing edge components, backend hosts and any boundary bypass that was observed to work.",
  },
  {
    id: "WSTG-CONF-01",
    section: "4.2.1",
    category: "CONF",
    title: "Test Network Infrastructure Configuration",
    objective:
      "Prove that the network services and devices protecting the application expose unpatched or misconfigured interfaces.",
    howToTest:
      "Scan all TCP and UDP services with nmap using version detection and default scripts, then review what the firewall allows: database, management and monitoring ports reachable from the internet, unauthenticated admin services and weak TLS on those services. Attempt a default or empty-credential login on every management interface found.",
    owasp: ["A02:2025", "A01:2025"],
    cwe: ["CWE-16", "CWE-1104"],
    tools: ["nmap", "nuclei", "curl", "run_python_script"],
    evidence: "nmap output per host plus the banner or response of each service that should not be reachable from the tested network.",
  },
  {
    id: "WSTG-CONF-02",
    section: "4.2.2",
    category: "CONF",
    title: "Test Application Platform Configuration",
    objective:
      "Prove that the application server, its sample files and its logging configuration are hardened.",
    howToTest:
      "Request default and sample resources directly (/server-status, /cgi-bin/, /admin.crt, sample apps, documentation bundles) and test whether directory listing is enabled. Check whether the platform logs security-relevant events, whether those logs are reachable over HTTP and whether error output is written to a world-readable file.",
    owasp: ["A02:2025", "A09:2025"],
    cwe: ["CWE-16", "CWE-552", "CWE-538"],
    tools: ["ffuf", "curl", "nuclei", "search_burp_proxy_history"],
    evidence: "Request/response pairs for each exposed default file or directory listing plus evidence of the logging configuration in use.",
  },
  {
    id: "WSTG-CONF-03",
    section: "4.2.3",
    category: "CONF",
    title: "Test File Extensions Handling for Sensitive Information",
    objective:
      "Prove that the web server serves or mishandles file extensions in a way that leaks source code or backup content.",
    howToTest:
      "Brute-force extension variants of known files (.bak, .old, ~, .swp, .inc, .txt, .zip, .tar.gz, .php.txt) and bypass handler blacklists with trailing dots or spaces, mixed case, double URL encoding and null-like characters. Note which extensions the server maps to which handler.",
    owasp: ["A02:2025", "A01:2025"],
    cwe: ["CWE-434", "CWE-552", "CWE-178"],
    tools: ["ffuf", "curl", "send_to_burp_intruder", "nuclei"],
    evidence: "The response that returned source code, backup content or a bypassed handler mapping, saved as a request/response pair.",
  },
  {
    id: "WSTG-CONF-04",
    section: "4.2.4",
    category: "CONF",
    title: "Review Old Backup and Unreferenced Files for Sensitive Information",
    objective:
      "Prove that backup archives and forgotten files are reachable and disclose source, configuration or credentials.",
    howToTest:
      "Fuzz the discovered directory tree with a backup-oriented wordlist and infer names from page titles, robots.txt entries, JS file names and common suffixes (.zip, .rar, .gz, .bak, .sql, copy-of-, _old). Download anything that resolves and confirm it contains sensitive data rather than a soft-404 page.",
    owasp: ["A02:2025", "A01:2025"],
    cwe: ["CWE-530", "CWE-552", "CWE-538"],
    tools: ["ffuf", "curl", "run_python_script", "nuclei"],
    evidence: "The downloaded archive or file plus the request/response pair proving it is publicly reachable without credentials.",
  },
  {
    id: "WSTG-CONF-05",
    section: "4.2.5",
    category: "CONF",
    title: "Enumerate Infrastructure and Application Admin Interfaces",
    objective:
      "Prove that administrative interfaces exist and are reachable without adequate network or authentication controls.",
    howToTest:
      "Fuzz admin, manager and console paths, mine robots.txt and HTML comments for hints, and port-scan for administrative services on alternate ports. Test whether the interface is protected by IP allow-listing, strong authentication and a WAF, or reachable by anyone.",
    owasp: ["A01:2025", "A02:2025"],
    cwe: ["CWE-284", "CWE-425", "CWE-306"],
    tools: ["ffuf", "nmap", "browser_action", "search_burp_proxy_history"],
    evidence: "Request/response pair or screenshot showing the admin interface reachable from a non-privileged network position.",
  },
  {
    id: "WSTG-CONF-06",
    section: "4.2.6",
    category: "CONF",
    title: "Test HTTP Methods",
    objective:
      "Prove that the server accepts verbs or method-override tricks that bypass access controls or enable writes.",
    howToTest:
      "Enumerate allowed methods with OPTIONS and a documented-method probe, then send arbitrary or unexpected verbs (TRACE, PUT, DELETE, CONNECT, DEBUG, random tokens, lowercase and mixed case) at protected endpoints. Finish with method-override headers such as X-HTTP-Method-Override and X-Method-Override.",
    owasp: ["A02:2025", "A01:2025"],
    cwe: ["CWE-650", "CWE-749"],
    tools: ["send_to_burp_repeater", "curl", "nmap", "send_to_burp_intruder"],
    evidence: "Request/response pairs for every accepted unexpected method and for any override header that changed the outcome.",
  },  {
    id: "WSTG-CONF-07",
    section: "4.2.7",
    category: "CONF",
    title: "Test HTTP Strict Transport Security",
    objective:
      "Prove that the application does not force browsers to use HTTPS for every request to the site.",
    howToTest:
      "Inspect the Strict-Transport-Security header on every HTTPS response, checking presence, max-age of at least a year, includeSubDomains and preload, then confirm the domain's status on the browser preload list. Request the same hosts over plain HTTP and load mixed-content pages to see whether an insecure request is possible.",
    owasp: ["A02:2025", "A04:2025"],
    cwe: ["CWE-319", "CWE-16"],
    tools: ["curl", "nuclei", "browser_action", "jq"],
    evidence: "The captured HSTS header, or its absence, for each host plus the plain-HTTP request that was not upgraded.",
  },
  {
    id: "WSTG-CONF-08",
    section: "4.2.8",
    category: "CONF",
    title: "Test RIA Cross Domain Policy",
    objective:
      "Prove that Flash/Flex cross-domain policy files grant more access than the application needs.",
    howToTest:
      "Fetch and parse crossdomain.xml, clientaccesspolicy.xml and any cross-domain policy embedded in served SWF or JS bundles, looking for wildcard domains, http:// entries, allow-http-request-headers-from and insecure site-control settings. Compare the allow-list with the domains the application actually consumes.",
    owasp: ["A02:2025", "A01:2025"],
    cwe: ["CWE-942", "CWE-16"],
    tools: ["curl", "browser_action", "run_python_script", "jq"],
    evidence: "The policy file contents with every overly permissive domain, header or wildcard rule highlighted.",
  },
  {
    id: "WSTG-CONF-09",
    section: "4.2.9",
    category: "CONF",
    title: "Test File Permission",
    objective:
      "Prove that sensitive files are readable or writable by users or processes that should not have access to them.",
    howToTest:
      "Where a shell or file-disclosure primitive exists, list permissions and ownership of the web root, configuration, credential and log files (find -perm -o+r -o -perm -o+w) and look for world-readable database dumps, backups and private keys. Without shell access, infer permissions through upload, download and editing features.",
    owasp: ["A02:2025", "A01:2025"],
    cwe: ["CWE-732", "CWE-276", "CWE-552"],
    tools: ["run_python_script", "curl", "ffuf", "search_burp_proxy_history"],
    evidence: "ls -l style evidence (mode, owner, group) for each sensitive file readable by the web user or an unprivileged account.",
  },
  {
    id: "WSTG-CONF-10",
    section: "4.2.10",
    category: "CONF",
    title: "Test for Subdomain Takeover",
    objective:
      "Prove that a DNS record or hosted service can be claimed by an attacker and used to serve content on the target domain.",
    howToTest:
      "Enumerate subdomains from certificate transparency, DNS brute force and search engines, then resolve them to find dangling CNAMEs pointing at unclaimed third-party services (S3, GitHub Pages, Heroku, Azure, Shopify, Fastly). Confirm the provider's unregistered-resource error signature without actually claiming the resource.",
    owasp: ["A03:2025", "A08:2025"],
    cwe: ["CWE-350", "CWE-284"],
    tools: ["curl", "nmap", "run_python_script"],
    evidence: "The dangling DNS record, the provider's unclaimed-resource response and a takeover proof-of-concept landing page screenshot.",
  },
  {
    id: "WSTG-CONF-11",
    section: "4.2.11",
    category: "CONF",
    title: "Test Cloud Storage",
    objective:
      "Prove that cloud storage buckets used by the application allow unauthorised listing, reading or writing.",
    howToTest:
      "Harvest bucket and container names from network traffic, JS bundles, DNS and brute force, then exercise each provider endpoint (S3, Azure Blob, Google Cloud Storage, DigitalOcean Spaces) for anonymous listing and object reads. Test write access with a harmless marker object only when authorised.",
    owasp: ["A01:2025", "A03:2025"],
    cwe: ["CWE-284", "CWE-639", "CWE-732"],
    tools: ["curl", "run_python_script", "search_burp_proxy_history", "jq"],
    evidence: "Request/response pair or CLI output showing a bucket listing or object contents retrieved without credentials.",
  },
  {
    id: "WSTG-IDNT-01",
    section: "4.3.1",
    category: "IDNT",
    title: "Test Role Definitions",
    objective:
      "Prove that the roles the application defines are documented, enforced and properly separated from one another.",
    howToTest:
      "Map each role by logging in with every account you have and comparing permissions, visible UI and API responses, then check the documentation and admin screens for a role matrix. Look for hidden or undeclared roles (admin, superuser, guest, service accounts) that the UI never exposes.",
    owasp: ["A01:2025", "A06:2025"],
    cwe: ["CWE-284", "CWE-266"],
    tools: ["browser_action", "search_burp_proxy_history", "send_to_burp_repeater", "jq"],
    evidence: "A role/permission matrix built from observed responses, naming the account used for each row.",
  },
  {
    id: "WSTG-IDNT-02",
    section: "4.3.2",
    category: "IDNT",
    title: "Test User Registration Process",
    objective:
      "Prove that the registration flow can be abused to create unauthorised, throttled-free, privileged or fake accounts.",
    howToTest:
      "Check whether registration is verified by e-mail or SMS, whether it can be repeated for the same identity, and whether the signup request accepts privileged fields (role, isAdmin, verified, balance) submitted by the client. Test for missing rate limiting and bot protection on the endpoint.",
    owasp: ["A07:2025", "A06:2025"],
    cwe: ["CWE-620", "CWE-799", "CWE-840"],
    tools: ["send_to_burp_repeater", "browser_action", "send_to_burp_intruder", "jq"],
    evidence: "Request/response pairs for the tampered or repeated registration together with the resulting account state.",
  },
  {
    id: "WSTG-IDNT-03",
    section: "4.3.3",
    category: "IDNT",
    title: "Test Account Provisioning Process",
    objective:
      "Prove that account creation, modification and de-provisioning privileges are properly segregated.",
    howToTest:
      "Determine who may create, modify, disable or delete accounts, then verify segregation of duties: try to self-provision an account, to have a lower-privileged user approve or edit a higher-privileged one, and to re-register a de-provisioned identity to inherit its previous access.",
    owasp: ["A01:2025", "A07:2025"],
    cwe: ["CWE-269", "CWE-265", "CWE-266"],
    tools: ["browser_action", "send_to_burp_repeater", "search_burp_proxy_history", "jq"],
    evidence: "Request/response pairs showing the provisioning action was accepted from an actor who should not be allowed to perform it.",
  },  {
    id: "WSTG-IDNT-04",
    section: "4.3.4",
    category: "IDNT",
    title: "Testing for Account Enumeration and Guessable User Account",
    objective:
      "Prove that the application reveals which usernames or accounts exist.",
    howToTest:
      "Compare responses for valid and invalid usernames in login, registration, password reset and any user lookup, looking at status code, body text, response length and timing. Automate the comparison with Intruder or ffuf over a username wordlist and repeat it to confirm the difference is stable and not noise.",
    owasp: ["A07:2025", "A01:2025"],
    cwe: ["CWE-203", "CWE-204", "CWE-200"],
    tools: ["send_to_burp_intruder", "ffuf", "send_to_burp_repeater", "run_python_script"],
    evidence: "Side-by-side valid versus invalid username responses, or a response-time delta table, that demonstrates the oracle.",
  },
  {
    id: "WSTG-IDNT-05",
    section: "4.3.5",
    category: "IDNT",
    title: "Testing for Weak or Unenforced Username Policy",
    objective:
      "Prove that the username policy is weak, predictable or enforced inconsistently across features.",
    howToTest:
      "Try registering and authenticating with case variants, leading or trailing whitespace, Unicode homoglyphs, e-mail style names and very short or sequential names, and check whether an existing username can be registered again or shadowed. Compare the policy applied at registration, password reset and SSO provisioning.",
    owasp: ["A07:2025", "A06:2025"],
    cwe: ["CWE-520", "CWE-521", "CWE-180"],
    tools: ["send_to_burp_intruder", "browser_action", "run_python_script", "jq"],
    evidence: "Request/response pairs for every accepted weak or colliding username together with the resulting account state.",
  },
  {
    id: "WSTG-ATHN-01",
    section: "4.4.1",
    category: "ATHN",
    title: "Testing for Credentials Transported over an Encrypted Channel",
    objective:
      "Prove that credentials are transmitted only over TLS and never leak to plain-text channels or referrers.",
    howToTest:
      "Submit the login form and inspect every request that carries credentials for the scheme and destination, then request the login page and the login endpoint over plain HTTP to see whether they answer. Check whether credentials appear in URLs, Referer headers, third-party resources or log files.",
    owasp: ["A04:2025", "A07:2025"],
    cwe: ["CWE-319", "CWE-522"],
    tools: ["search_burp_proxy_history", "curl", "send_to_burp_repeater", "browser_action"],
    evidence: "A request pair showing credentials sent over http:// or to a non-TLS endpoint, plus the HTTP-only login page URL.",
  },
  {
    id: "WSTG-ATHN-02",
    section: "4.4.2",
    category: "ATHN",
    title: "Testing for Default Credentials",
    objective:
      "Prove that default or vendor-standard credentials still grant access to the application or its components.",
    howToTest:
      "Try documented default credential pairs (admin/admin, admin/password, root/root, product defaults) against the application login, admin consoles and any management service found by nmap. Automate a short candidate list and reset any lockout counter between batches so the test does not block accounts.",
    owasp: ["A07:2025", "A02:2025"],
    cwe: ["CWE-1392", "CWE-798", "CWE-521"],
    tools: ["send_to_burp_intruder", "nmap", "run_python_script", "browser_action"],
    evidence: "Request/response pair or screenshot showing a successful authentication with a default credential pair.",
  },
  {
    id: "WSTG-ATHN-03",
    section: "4.4.3",
    category: "ATHN",
    title: "Testing for Weak Lock Out Mechanism",
    objective:
      "Prove that the lockout or anti-automation control is missing or bypassable, allowing password brute force.",
    howToTest:
      "Send repeated failed logins and record the lockout, CAPTCHA or delay behaviour, then test bypasses: counter reset by a successful login, IP rotation or X-Forwarded-For spoofing, case and whitespace variants of the same account, extra or removed parameters, and performing the flow steps out of order.",
    owasp: ["A07:2025", "A09:2025"],
    cwe: ["CWE-307", "CWE-799", "CWE-778"],
    tools: ["send_to_burp_intruder", "run_python_script", "send_to_burp_repeater", "jq"],
    evidence: "An Intruder or script log of hundreds of failed attempts without lockout, or the exact request that reset the counter.",
  },
  {
    id: "WSTG-ATHN-04",
    section: "4.4.4",
    category: "ATHN",
    title: "Testing for Bypassing Authentication Schema",
    objective:
      "Prove that authentication can be skipped by reaching protected resources directly or by making the server believe a session is authenticated.",
    howToTest:
      "Request protected pages, files and APIs without a session and force-browse to post-authentication URLs, then manipulate parameters, headers, hidden fields and cookies the application trusts (role, authenticated, user id). Include the classic variants where a SQL-injectable login or a client-supplied credential check returns the protected page.",
    owasp: ["A07:2025", "A01:2025"],
    cwe: ["CWE-287", "CWE-306", "CWE-472"],
    tools: ["send_to_burp_repeater", "curl", "ffuf", "send_to_burp_intruder"],
    evidence: "Request/response pair showing a protected resource returned to an unauthenticated or forged session.",
  },
  {
    id: "WSTG-ATHN-05",
    section: "4.4.5",
    category: "ATHN",
    title: "Testing for Vulnerable Remember Password",
    objective:
      "Prove that the remember-password feature stores weak, reversible or indefinitely valid credentials.",
    howToTest:
      "Enable remember password and inspect the persistent cookie and browser storage: base64 or plaintext credentials, unsalted hashes, static values, or an auto-login token with no expiry or device binding. Verify whether the value still works after a password change and when replayed from a different browser.",
    owasp: ["A07:2025", "A04:2025"],
    cwe: ["CWE-522", "CWE-539", "CWE-256"],
    tools: ["browser_action", "search_burp_proxy_history", "send_to_burp_repeater", "run_python_script"],
    evidence: "The stored token value, the request that re-establishes the session with it and the result of replaying it after a password change.",
  },
  {
    id: "WSTG-ATHN-06",
    section: "4.4.6",
    category: "ATHN",
    title: "Testing for Browser Cache Weaknesses",
    objective:
      "Prove that authenticated or sensitive pages can be recovered from the browser or shared cache after logout.",
    howToTest:
      "After logging out, use the browser back button and a cache-only reload on sensitive pages, then inspect the cache headers (Cache-Control, Pragma, Expires, Vary, ETag) of authenticated responses. Test whether an unauthenticated conditional or range request can retrieve a cached authenticated response from a shared proxy.",
    owasp: ["A07:2025", "A02:2025"],
    cwe: ["CWE-525", "CWE-524", "CWE-200"],
    tools: ["browser_action", "curl", "search_burp_proxy_history", "jq"],
    evidence: "Screenshot or response proving a sensitive page was restored from cache after logout, with its cache headers recorded.",
  },  {
    id: "WSTG-ATHN-07",
    section: "4.4.7",
    category: "ATHN",
    title: "Testing for Weak Password Policy",
    objective:
      "Prove that the password policy is too weak to withstand guessing or offline brute force.",
    howToTest:
      "Enumerate the enforced policy by attempting short, dictionary, repeated-character, context-specific (company, product, username-derived) and breached passwords at registration and password change. Compare what the client-side validation allows with what the server actually accepts and reject.",
    owasp: ["A07:2025", "A06:2025"],
    cwe: ["CWE-521", "CWE-620"],
    tools: ["send_to_burp_intruder", "browser_action", "run_python_script", "jq"],
    evidence: "Request/response pairs for each accepted weak password plus the exact gap between the documented and enforced policy.",
  },
  {
    id: "WSTG-ATHN-08",
    section: "4.4.8",
    category: "ATHN",
    title: "Testing for Weak Security Question Answer",
    objective:
      "Prove that knowledge-based authentication can be guessed or brute-forced.",
    howToTest:
      "Read the security questions offered and rank them for guessability, then brute-force answers with small dictionaries of common and target-specific values (pet names, cities, colours, maiden names) at both the reset and login flows. Check whether answers are case-insensitive, unhashed and free of lockout.",
    owasp: ["A07:2025", "A06:2025"],
    cwe: ["CWE-640", "CWE-307", "CWE-521"],
    tools: ["send_to_burp_intruder", "browser_action", "run_python_script", "search_burp_proxy_history"],
    evidence: "Request/response pairs of the successful answer guesses together with the number of attempts it took.",
  },
  {
    id: "WSTG-ATHN-09",
    section: "4.4.9",
    category: "ATHN",
    title: "Testing for Weak Password Change or Reset Functionalities",
    objective:
      "Prove that password change or reset can be performed by, or on behalf of, the wrong party.",
    howToTest:
      "Analyse the reset flow end to end: token entropy, binding to the account, expiry, reuse, and whether the old password is required. Then tamper with the identity in the request (e-mail, user id, GUID) from an unauthenticated position and from an authenticated attacker account to reset someone else's password.",
    owasp: ["A07:2025", "A01:2025"],
    cwe: ["CWE-640", "CWE-620", "CWE-330"],
    tools: ["send_to_burp_repeater", "browser_action", "send_to_burp_intruder", "run_python_script"],
    evidence: "Request/response pairs proving another account's password was reset, or that an expired/reused token was accepted, with the token value.",
  },
  {
    id: "WSTG-ATHN-10",
    section: "4.4.10",
    category: "ATHN",
    title: "Testing for Weaker Authentication in Alternative Channel",
    objective:
      "Prove that alternative channels authenticate more weakly than the primary web channel.",
    howToTest:
      "Enumerate alternative channels (mobile API, legacy or print-only pages, SSO/IdP, support desk, IVR, kiosk) and compare their controls with the primary one: MFA, CAPTCHA, lockout, password rules and session binding. Test each channel for a bypass, e.g. an API login that skips MFA entirely.",
    owasp: ["A07:2025", "A06:2025"],
    cwe: ["CWE-287", "CWE-1390", "CWE-306"],
    tools: ["browser_action", "curl", "search_burp_proxy_history", "send_to_burp_repeater"],
    evidence: "Requests proving the alternative channel authenticated with weaker controls, such as an MFA-less API login.",
  },
  {
    id: "WSTG-ATHZ-01",
    section: "4.5.1",
    category: "ATHZ",
    title: "Testing Directory Traversal File Include",
    objective:
      "Prove that path traversal or file inclusion can read or execute files outside the intended directory.",
    howToTest:
      "Inject traversal and encoding variants (../, ..\\, %2e%2e%2f, %252e, overlong UTF-8, absolute paths, null bytes) into path parameters, file and template includes, download and archive-extraction features, and confirm exact file contents. Where the include executes, escalate through log poisoning, /proc/self/environ or a session file to prove code execution.",
    owasp: ["A01:2025", "A05:2025"],
    cwe: ["CWE-22", "CWE-23", "CWE-98"],
    tools: ["send_to_burp_intruder", "ffuf", "curl", "run_python_script"],
    evidence: "Retrieved file contents, or the included payload executing, with the exact traversal payload and a full request/response pair.",
  },
  {
    id: "WSTG-ATHZ-02",
    section: "4.5.2",
    category: "ATHZ",
    title: "Testing for Bypassing Authorization Schema",
    objective:
      "Prove that protected resources or privileged functions can be reached without the required authorisation.",
    howToTest:
      "Replay privileged requests with a low-privilege session for every role, testing horizontal and vertical access on admin panels, API endpoints and direct resource requests. Then try schema bypasses: path casing, trailing dot or space, URL encoding, double slashes, /./, ;/, alternative verbs and header overrides.",
    owasp: ["A01:2025", "A06:2025"],
    cwe: ["CWE-285", "CWE-863", "CWE-425"],
    tools: ["send_to_burp_repeater", "send_to_burp_intruder", "ffuf", "browser_action"],
    evidence: "Request/response pair showing the privileged resource returned to the low-privilege session, with the body diff highlighted.",
  },
  {
    id: "WSTG-ATHZ-03",
    section: "4.5.3",
    category: "ATHZ",
    title: "Testing for Privilege Escalation",
    objective:
      "Prove that a user can increase their own privileges or act as another role.",
    howToTest:
      "Tamper with every parameter, JWT claim, cookie or hidden field that carries the role or permission (role=user to admin, isAdmin, group ids, tenant ids), and try to modify other users' roles where the UI hides the action. Chain the escalation with mass assignment or forced browsing to confirm the new privilege persists.",
    owasp: ["A01:2025", "A07:2025"],
    cwe: ["CWE-269", "CWE-266", "CWE-639"],
    tools: ["send_to_burp_repeater", "send_to_burp_intruder", "run_python_script", "browser_action"],
    evidence: "Before/after request pairs showing the elevated role persisted, e.g. an admin-only page or API call succeeding.",
  },
  {
    id: "WSTG-ATHZ-04",
    section: "4.5.4",
    category: "ATHZ",
    title: "Testing for Insecure Direct Object References",
    objective:
      "Prove that object identifiers can be swapped to access or modify other users' data.",
    howToTest:
      "Find every direct object reference (numeric ids, UUIDs, filenames, hashes) in URLs, bodies, JSON, GraphQL nodes and exports, then substitute the identifiers of a second account with the same role. Test read and write operations, plus sequential, predictable, encoded or compressed id formats and array-wrapped ids.",
    owasp: ["A01:2025"],
    cwe: ["CWE-639", "CWE-284", "CWE-566"],
    tools: ["send_to_burp_intruder", "send_to_burp_repeater", "run_python_script", "jq"],
    evidence: "Paired responses for the same endpoint using two accounts' object ids, proving cross-account disclosure or modification.",
  },  {
    id: "WSTG-SESS-01",
    section: "4.6.1",
    category: "SESS",
    title: "Testing for Session Management Schema",
    objective:
      "Prove that session tokens are unpredictable, unique and never derived from user-controlled data.",
    howToTest:
      "Collect a large token sample and analyse it for entropy, patterns, sequential or timestamp-derived parts and decodable structure (base64, hex, JWT). Compare tokens issued in the same second, from different accounts, after re-login and before/after privilege change to detect reuse or predictability.",
    owasp: ["A07:2025", "A04:2025"],
    cwe: ["CWE-330", "CWE-338", "CWE-539"],
    tools: ["send_to_burp_intruder", "run_python_script", "search_burp_proxy_history", "jq"],
    evidence: "A sample of at least one hundred tokens plus the entropy and pattern analysis output derived from them.",
  },
  {
    id: "WSTG-SESS-02",
    section: "4.6.2",
    category: "SESS",
    title: "Testing for Cookies Attributes",
    objective:
      "Prove that session cookies lack the attributes that limit theft, tampering and automatic transmission.",
    howToTest:
      "Inspect Set-Cookie for Secure, HttpOnly, SameSite, Path, Domain and expiry on every host, then verify the behaviour end to end: whether the cookie travels over plain HTTP, whether JavaScript can read it, and whether it is valid on sibling subdomains. Test cookie shadowing by setting the same name with a broader domain or path.",
    owasp: ["A07:2025", "A02:2025"],
    cwe: ["CWE-1004", "CWE-614", "CWE-1275"],
    tools: ["search_burp_proxy_history", "browser_action", "curl", "send_to_burp_repeater"],
    evidence: "Captured Set-Cookie headers with the missing attributes highlighted and the request proving the cookie reached an insecure context.",
  },
  {
    id: "WSTG-SESS-03",
    section: "4.6.3",
    category: "SESS",
    title: "Testing for Session Fixation",
    objective:
      "Prove that the session identifier is not renewed on authentication or privilege change.",
    howToTest:
      "Record the session identifier before login, authenticate, and compare it with the post-login value. Then plant a chosen value through the URL or cookie and check whether it is adopted, and confirm that anonymous-to-authenticated and account-switch transitions all rotate the token.",
    owasp: ["A07:2025", "A01:2025"],
    cwe: ["CWE-384", "CWE-287"],
    tools: ["send_to_burp_repeater", "browser_action", "search_burp_proxy_history", "curl"],
    evidence: "Pre- and post-authentication requests sharing the same session identifier, or a planted identifier that authenticates successfully.",
  },
  {
    id: "WSTG-SESS-04",
    section: "4.6.4",
    category: "SESS",
    title: "Testing for Exposed Session Variables",
    objective:
      "Prove that session state leaks into URLs, referrers, logs, caches or client-side storage where it can be captured.",
    howToTest:
      "Search the proxy history for session identifiers, tokens and credentials in query strings, then follow the referrer chain to third-party hosts. Inspect localStorage, sessionStorage, IndexedDB, service worker caches and cached responses for the same values, and look for state carried over plain HTTP.",
    owasp: ["A07:2025", "A02:2025"],
    cwe: ["CWE-598", "CWE-200", "CWE-922"],
    tools: ["search_burp_proxy_history", "browser_action", "jq", "run_python_script"],
    evidence: "The request/response showing the session value in a URL or referrer, or its presence in browser storage, naming the receiving host.",
  },
  {
    id: "WSTG-SESS-05",
    section: "4.6.5",
    category: "SESS",
    title: "Testing for Cross Site Request Forgery",
    objective:
      "Prove that state-changing requests can be forged from another origin on behalf of an authenticated user.",
    howToTest:
      "For each state-changing endpoint check for an anti-CSRF token and its binding to the session, then remove, blank, reuse or replace it and see whether the request still succeeds. Test the other controls too: SameSite cookies, Origin/Referer validation, custom headers, GET-based state changes and JSON or text/plain content types.",
    owasp: ["A01:2025", "A06:2025"],
    cwe: ["CWE-352", "CWE-1275"],
    tools: ["send_to_burp_repeater", "browser_action", "burp_collaborator", "curl"],
    evidence: "A working CSRF proof-of-concept page plus the request that changed state without a valid anti-CSRF token.",
  },
  {
    id: "WSTG-SESS-06",
    section: "4.6.6",
    category: "SESS",
    title: "Testing for Logout Functionality",
    objective:
      "Prove that logout invalidates the session server-side across every session, channel and device.",
    howToTest:
      "After logging out, replay the captured session cookie or API token and re-open cached authenticated pages, then test logout links that only redirect and alternate logout endpoints. Check whether logging out on one channel (web, mobile, API) invalidates the tokens issued to the others.",
    owasp: ["A07:2025", "A01:2025"],
    cwe: ["CWE-613", "CWE-287"],
    tools: ["send_to_burp_repeater", "browser_action", "curl", "search_burp_proxy_history"],
    evidence: "Post-logout request/response pair still returning authenticated content with the old session token.",
  },
  {
    id: "WSTG-SESS-07",
    section: "4.6.7",
    category: "SESS",
    title: "Testing Session Timeout",
    objective:
      "Prove that idle and absolute session expiration are enforced on the server rather than only in the browser.",
    howToTest:
      "Leave a session idle beyond the documented idle timeout and replay a request, then keep it alive with low-frequency traffic past the absolute timeout and replay again. Test whether the client-side timeout is the only control and whether tokens survive a password change or privilege change.",
    owasp: ["A07:2025", "A06:2025"],
    cwe: ["CWE-613", "CWE-287"],
    tools: ["run_python_script", "send_to_burp_repeater", "curl", "search_burp_proxy_history"],
    evidence: "Timestamped request/response pairs showing a request succeeding after the stated idle or absolute timeout.",
  },
  {
    id: "WSTG-SESS-08",
    section: "4.6.8",
    category: "SESS",
    title: "Testing for Session Puzzling",
    objective:
      "Prove that a session variable set by one flow is consumed by another, producing an unexpected state.",
    howToTest:
      "On a single session, populate every session variable reachable from the outside via registration, password reset, error pages, profile fields and language selection, then jump straight to privileged pages. Observe whether the polluted state bypasses authentication or makes the user appear verified.",
    owasp: ["A07:2025", "A06:2025"],
    cwe: ["CWE-488", "CWE-384", "CWE-287"],
    tools: ["browser_action", "send_to_burp_repeater", "search_burp_proxy_history", "run_python_script"],
    evidence: "The request sequence proving a reused session variable produced unauthorised access or a false verified state.",
  },
  {
    id: "WSTG-SESS-09",
    section: "4.6.9",
    category: "SESS",
    title: "Testing for Session Hijacking",
    objective:
      "Prove that an attacker holding a valid session token can take over the account.",
    howToTest:
      "Capture a live token through any disclosure primitive (XSS, insecure transport, predictable value, logs, referrer), then replay it from a different IP, user agent and browser profile and verify access. Check whether the token is bound to anything and whether concurrent use from another fingerprint is detected or alerted on.",
    owasp: ["A07:2025", "A09:2025"],
    cwe: ["CWE-287", "CWE-384", "CWE-539"],
    tools: ["send_to_burp_repeater", "curl", "browser_action", "run_python_script"],
    evidence: "The captured token, the replay request from a different client fingerprint and the authenticated response it returned.",
  },  {
    id: "WSTG-INPV-01",
    section: "4.7.1",
    category: "INPV",
    title: "Testing for Reflected Cross Site Scripting",
    objective:
      "Prove that user input is reflected into an HTML or JavaScript context without correct output encoding.",
    howToTest:
      "Fuzz every reflected parameter with canary strings that include HTML and JS context breakers, then inspect where the value lands (element body, attribute, script block, URL). Bypass filters with case changes, double encoding, Unicode escapes and unquoted attributes, and prove execution in a real browser with an impact payload rather than alert().",
    owasp: ["A05:2025"],
    cwe: ["CWE-79"],
    tools: ["send_to_burp_repeater", "browser_action", "view_image", "send_to_burp_intruder"],
    evidence: "Screenshot or console log of the payload executing plus the request/response pair containing the unencoded reflection.",
  },
  {
    id: "WSTG-INPV-02",
    section: "4.7.2",
    category: "INPV",
    title: "Testing for Stored Cross Site Scripting",
    objective:
      "Prove that input persisted by the application is later rendered as executable markup for another user.",
    howToTest:
      "Submit payloads through every write path (profile fields, comments, filenames, support tickets, admin-only inputs, API fields, imported documents) and trigger rendering in different contexts: admin review screens, e-mail templates, PDF exports and mobile views. Poll the stored value repeatedly because rendering is often delayed or asynchronous.",
    owasp: ["A05:2025"],
    cwe: ["CWE-79", "CWE-116"],
    tools: ["send_to_burp_repeater", "browser_action", "search_burp_proxy_history", "view_image"],
    evidence: "The stored payload as read back from the API plus a screenshot of it executing in the victim's browser context.",
  },
  {
    id: "WSTG-INPV-03",
    section: "4.7.3",
    category: "INPV",
    title: "Testing for HTTP Verb Tampering",
    objective:
      "Prove that access-control or authentication decisions depend on the HTTP method and can be bypassed by changing it.",
    howToTest:
      "For each protected resource, replay the request with alternative methods (HEAD, OPTIONS, PUT, DELETE, PATCH, TRACE, arbitrary tokens, lowercase and mixed case) and check whether the restriction disappears. Combine with method-override headers and with verbs the framework maps to the same handler.",
    owasp: ["A01:2025", "A02:2025"],
    cwe: ["CWE-650", "CWE-288"],
    tools: ["send_to_burp_repeater", "send_to_burp_intruder", "curl", "ffuf"],
    evidence: "Request/response pairs where an alternative verb returned protected content or performed a write.",
  },
  {
    id: "WSTG-INPV-04",
    section: "4.7.4",
    category: "INPV",
    title: "Testing for HTTP Parameter Pollution",
    objective:
      "Prove that duplicated or reordered parameters make the application act on a value it did not validate.",
    howToTest:
      "Send the same parameter two or more times in query strings, form bodies, cookies and headers with different values, using the separators and notations different servers accept (&, ;, %26, [], .). Compare responses with the ignored copy, and test whether a WAF or validator reads one instance while the backend consumes another.",
    owasp: ["A05:2025", "A01:2025"],
    cwe: ["CWE-235", "CWE-436"],
    tools: ["send_to_burp_repeater", "send_to_burp_intruder", "run_python_script", "jq"],
    evidence: "Request/response pair showing the duplicate parameter reaching the backend or bypassing validation, with the separator used.",
  },
  {
    id: "WSTG-INPV-05",
    section: "4.7.5",
    category: "INPV",
    title: "Testing for SQL Injection",
    objective:
      "Prove that user input reaches a database query without parameterisation, allowing data disclosure or modification.",
    howToTest:
      "Fuzz every query-backed parameter with quote, comment and boolean or arithmetic canaries, then exploit per database: UNION and stacked queries for MySQL/MariaDB, dual and rownum tricks for Oracle, xp_cmdshell and waitfor delay for SQL Server, COPY and pg_sleep for PostgreSQL, and error-based guessing for MS Access. Cover the guide's sub-techniques as well - NoSQL injection ($ne, $gt, $where and JSON operator injection against MongoDB), ORM injection (HQL, JPQL, Sequelize operator objects) and client-side SQL (Web SQL and offline storage) - and escalate through error-based, blind boolean and time-based variants with sqlmap once a parameter is confirmed.",
    owasp: ["A05:2025"],
    cwe: ["CWE-89", "CWE-943"],
    tools: ["sqlmap", "send_to_burp_repeater", "send_to_burp_intruder", "run_python_script"],
    evidence: "The request/response pair with the working payload and the extracted data, schema or confirmed time/boolean oracle.",
  },
  {
    id: "WSTG-INPV-06",
    section: "4.7.6",
    category: "INPV",
    title: "Testing for LDAP Injection",
    objective:
      "Prove that input is concatenated into an LDAP filter, allowing query manipulation or filter bypass.",
    howToTest:
      "Inject LDAP metacharacters (*, )(, |, &, !, null and backslash) into authentication and directory search parameters to turn a filter into a wildcard and look for authentication bypass or extra entries. Use response differences and error messages for blind detection, and target AD-specific attributes such as objectClass, sAMAccountName and userPassword.",
    owasp: ["A05:2025", "A07:2025"],
    cwe: ["CWE-90", "CWE-74"],
    tools: ["send_to_burp_repeater", "send_to_burp_intruder", "run_python_script", "jq"],
    evidence: "Request/response pair showing the injected filter changed authentication or returned directory data the caller should not see.",
  },
  {
    id: "WSTG-INPV-07",
    section: "4.7.7",
    category: "INPV",
    title: "Testing for XML Injection",
    objective:
      "Prove that untrusted input builds XML documents or reaches an XML parser that can be abused.",
    howToTest:
      "Inject XML metacharacters and whole elements into parameters that generate XML, then attack the parser: external entities for file disclosure and SSRF, entity expansion for denial of service, XInclude and DTD-based error exfiltration. Cover SOAP and REST endpoints, SVG, Office/ODF documents and any import that parses XML.",
    owasp: ["A05:2025", "A01:2025"],
    cwe: ["CWE-91", "CWE-611", "CWE-776"],
    tools: ["send_to_burp_repeater", "burp_collaborator", "send_to_burp_intruder", "run_python_script"],
    evidence: "The response containing the resolved external entity or file contents, or the collaborator interaction that proves out-of-band resolution.",
  },
  {
    id: "WSTG-INPV-08",
    section: "4.7.8",
    category: "INPV",
    title: "Testing for SSI Injection",
    objective:
      "Prove that server-side include directives can be injected and are evaluated by the web server.",
    howToTest:
      "Inject SSI directives that echo environment variables, include arbitrary files and execute commands into every input that reaches a page the server compiles, including uploads, error pages and .shtml or .stm resources. Check whether the directive is evaluated, escaped or simply returned, and which include paths are permitted.",
    owasp: ["A05:2025"],
    cwe: ["CWE-97", "CWE-74"],
    tools: ["send_to_burp_repeater", "curl", "send_to_burp_intruder", "search_burp_proxy_history"],
    evidence: "The response with the evaluated directive, for example server variables or included file contents, plus the payload that produced it.",
  },
  {
    id: "WSTG-INPV-09",
    section: "4.7.9",
    category: "INPV",
    title: "Testing for XPath Injection",
    objective:
      "Prove that input concatenated into an XPath expression can change the query result or bypass authentication.",
    howToTest:
      "Inject quotes, brackets and XPath operators (or 1=1, and 1=2, |, substring(), count(), position()) into XML-backed search and login functions and compare the responses for tautology and contradiction behaviour. Use node counts, error text and timing as a blind oracle when the result set is not returned.",
    owasp: ["A05:2025", "A07:2025"],
    cwe: ["CWE-643", "CWE-74"],
    tools: ["send_to_burp_repeater", "send_to_burp_intruder", "run_python_script", "jq"],
    evidence: "Request/response pair showing the injected XPath bypassed authentication or returned nodes the caller should not receive.",
  },  {
    id: "WSTG-INPV-10",
    section: "4.7.10",
    category: "INPV",
    title: "Testing for IMAP SMTP Injection",
    objective:
      "Prove that user input reaches an IMAP or SMTP command stream, allowing message or mailbox manipulation.",
    howToTest:
      "Inject CRLF sequences and IMAP/SMTP metacharacters into mail-related parameters (contact forms, tell-a-friend, ticket ingestion, IMAP search strings, e-mail to SMS gateways) and inspect the resulting message headers and recipient list. Confirm whether extra commands are executed and whether copies are delivered to unintended recipients.",
    owasp: ["A05:2025"],
    cwe: ["CWE-93", "CWE-88", "CWE-77"],
    tools: ["send_to_burp_repeater", "burp_collaborator", "run_python_script", "curl"],
    evidence: "The delivered message with injected headers or recipients, or the SMTP/IMAP transaction log showing the extra commands.",
  },
  {
    id: "WSTG-INPV-11",
    section: "4.7.11",
    category: "INPV",
    title: "Testing for Code Injection",
    objective:
      "Prove that input is evaluated as code, or that server-side files can be included and executed.",
    howToTest:
      "Cover both sub-techniques. For Local File Inclusion (4.7.11.1) traverse include, template and file parameters with ../ and encoding variants, read /etc/passwd or the application configuration, then escalate through log poisoning, /proc/self/environ, session files or an upload plus include to reach code execution. For Remote File Inclusion (4.7.11.2) point include-style parameters at attacker-controlled URLs and wrappers (http, ftp, php://input, data://, expect://) and watch for the callback. Also test language-level injection where input reaches eval, exec or deserialisation sinks.",
    owasp: ["A05:2025", "A01:2025"],
    cwe: ["CWE-94", "CWE-98", "CWE-95"],
    tools: ["send_to_burp_repeater", "burp_collaborator", "ffuf", "run_python_script"],
    evidence: "Command or code output, or the collaborator callback from the included remote file, saved with the payload and full request.",
  },
  {
    id: "WSTG-INPV-12",
    section: "4.7.12",
    category: "INPV",
    title: "Testing for Command Injection",
    objective:
      "Prove that input reaches an OS command interpreter, allowing arbitrary command execution.",
    howToTest:
      "Inject shell metacharacters and separators (; | || && backticks, $(), redirects, newlines) plus blind payloads (sleep, ping, nslookup, curl) into parameters that invoke system tools such as ping, DNS or whois lookups, conversions, backups and archive operations. Confirm with timing delays, output reflection or out-of-band interaction.",
    owasp: ["A05:2025"],
    cwe: ["CWE-78", "CWE-77", "CWE-88"],
    tools: ["send_to_burp_repeater", "burp_collaborator", "send_to_burp_intruder", "run_python_script"],
    evidence: "Command output (id, whoami, hostname) or a collaborator DNS/HTTP interaction, with the response-time delta and the payload used.",
  },
  {
    id: "WSTG-INPV-13",
    section: "4.7.13",
    category: "INPV",
    title: "Testing for Format String Injection",
    objective:
      "Prove that user input is passed as a format string to printf-style functions, leaking memory or corrupting execution.",
    howToTest:
      "Inject format specifiers (%s, %n, %x, %p and long repetitions of them) into inputs that are logged, printed, exported or used to build error and report messages, and look for hex memory disclosure, malformed output, crashes or restarts. Include batch exports, notification templates and reporting features as well as request parameters.",
    owasp: ["A10:2025", "A05:2025"],
    cwe: ["CWE-134", "CWE-787"],
    tools: ["send_to_burp_repeater", "send_to_burp_intruder", "run_python_script", "curl"],
    evidence: "The response containing leaked memory addresses or stack values, or the request that crashed the service, with the exact format string.",
  },
  {
    id: "WSTG-INPV-14",
    section: "4.7.14",
    category: "INPV",
    title: "Testing for Incubated Vulnerability",
    objective:
      "Prove that stored input becomes dangerous only later, when an automated or privileged process consumes it.",
    howToTest:
      "Persist payloads in every input the application stores, then trigger or wait for the consumer: batch jobs, queue workers, cron tasks, exports, report builders, admin review queues, indexers and log parsers. Re-test each stored value after the background process has run and compare the before and after state.",
    owasp: ["A05:2025", "A08:2025"],
    cwe: ["CWE-79", "CWE-89"],
    tools: ["send_to_burp_repeater", "run_python_script", "search_burp_proxy_history", "browser_action"],
    evidence: "The timestamped request that stored the payload plus the later evidence of execution, such as a log entry, generated file or triggered request.",
  },  {
    id: "WSTG-INPV-15",
    section: "4.7.15",
    category: "INPV",
    title: "Testing for HTTP Splitting Smuggling",
    objective:
      "Prove that CRLF injection or disagreement between HTTP parsers allows response splitting or request smuggling.",
    howToTest:
      "Inject CRLF sequences and header delimiters (%0d%0a, %23%0a, raw newlines, Unicode variants) into parameters echoed into headers or redirects and look for injected Set-Cookie or Location fields. Then probe desynchronisation with conflicting Content-Length and Transfer-Encoding headers, obfuscated chunk sizes and CL.0/TE.TE/TE.CL variants using timing, response diffs and a collaborator endpoint as the oracle.",
    owasp: ["A05:2025", "A01:2025"],
    cwe: ["CWE-113", "CWE-444"],
    tools: ["send_to_burp_repeater", "burp_collaborator", "run_python_script", "curl"],
    evidence: "The split response carrying the injected header, or the smuggled request's collaborator hit, with the exact desync payload.",
  },
  {
    id: "WSTG-INPV-16",
    section: "4.7.16",
    category: "INPV",
    title: "Testing for HTTP Incoming Requests",
    objective:
      "Prove that the host accepts inbound requests it should not, such as internal-only endpoints or debug surfaces.",
    howToTest:
      "Replay unexpected inbound traffic against the edge and watch which hosts answer: debug and health endpoints, status or metrics pages, internal names exposed by a reverse proxy, and paths reachable through proxy normalisation quirks. Compare the reachable surface with the documented one.",
    owasp: ["A02:2025", "A05:2025"],
    cwe: ["CWE-16", "CWE-200"],
    tools: ["curl", "nmap", "search_burp_proxy_history", "run_python_script"],
    evidence: "The unexpected request/response pair proving an internal-only endpoint answered an external request.",
  },
  {
    id: "WSTG-INPV-17",
    section: "4.7.17",
    category: "INPV",
    title: "Testing for Host Header Injection",
    objective:
      "Prove that the application trusts the Host header, allowing cache poisoning, link hijacking or routing bypass.",
    howToTest:
      "Send requests with attacker-controlled Host and X-Forwarded-Host values (plus absolute-URI request lines) to pages that build links, redirects, password-reset URLs, cache keys or virtual-host routing, and check whether the injected host appears in the response or in generated e-mail. Test whether the poisoned response is cached and served to other users.",
    owasp: ["A05:2025", "A01:2025"],
    cwe: ["CWE-20", "CWE-644", "CWE-601"],
    tools: ["send_to_burp_repeater", "burp_collaborator", "curl", "search_burp_proxy_history"],
    evidence: "The response or e-mail containing the injected host, the request that produced it and the affected cache key.",
  },
  {
    id: "WSTG-INPV-18",
    section: "4.7.18",
    category: "INPV",
    title: "Testing for Server-side Template Injection",
    objective:
      "Prove that user input is evaluated inside a server-side template engine, allowing data disclosure or code execution.",
    howToTest:
      "Send template canaries (${7*7}, {{7*7}}, <%= 7*7 %>, #{7*7}, ${{7*7}}) to every parameter that is rendered server-side and fingerprint the engine from the evaluated output. Escalate with engine-specific payloads for Jinja2, Twig, Freemarker, Velocity, Smarty, Pebble, Mako and ERB, moving from object inspection to file read and command execution.",
    owasp: ["A05:2025", "A06:2025"],
    cwe: ["CWE-1336", "CWE-94"],
    tools: ["send_to_burp_repeater", "send_to_burp_intruder", "run_python_script", "burp_collaborator"],
    evidence: "The response with the evaluated expression plus the engine-specific payload that reached file read or command execution.",
  },
  {
    id: "WSTG-INPV-19",
    section: "4.7.19",
    category: "INPV",
    title: "Testing for Server-Side Request Forgery",
    objective:
      "Prove that the server can be made to issue requests to attacker-chosen destinations from its privileged network position.",
    howToTest:
      "Fuzz URL-like parameters (webhooks, importers, image and PDF generators, SSO metadata, link previews) with internal targets (127.0.0.1, localhost aliases, 169.254.169.254, RFC1918 ranges, [::1], decimal, octal and IPv6-mapped forms) and a collaborator host. Bypass filters with redirects, DNS rebinding, URL parsing differences, protocol wrappers (gopher, file, dict, sftp) and case or credential-prefix tricks.",
    owasp: ["A01:2025", "A05:2025"],
    cwe: ["CWE-918"],
    tools: ["send_to_burp_repeater", "burp_collaborator", "run_python_script"],
    evidence: "The collaborator interaction, cloud metadata response or internal service response returned through the SSRF, with the destination used.",
  },
  {
    id: "WSTG-ERRH-01",
    section: "4.8.1",
    category: "ERRH",
    title: "Testing for Improper Error Handling",
    objective:
      "Prove that errors reveal internal detail or are handled so inconsistently that they become an oracle.",
    howToTest:
      "Trigger errors deliberately across every endpoint: invalid types, oversized values, missing or duplicated parameters, malformed JSON and XML, unexpected content types and unsupported methods. Compare status codes, bodies and timing for stack traces, framework names, SQL fragments and internal paths, and check whether the error was logged and alerted on.",
    owasp: ["A10:2025", "A09:2025"],
    cwe: ["CWE-209", "CWE-391", "CWE-756"],
    tools: ["send_to_burp_intruder", "send_to_burp_repeater", "ffuf", "run_python_script"],
    evidence: "The error response containing internal detail next to the request that triggered it, plus whether any log entry or alert was produced.",
  },
  {
    id: "WSTG-ERRH-02",
    section: "4.8.2",
    category: "ERRH",
    title: "Testing for Stack Traces",
    objective:
      "Prove that unhandled exceptions expose stack traces, framework versions and code paths to the user.",
    howToTest:
      "Force exceptions in every technology present: malformed Java paths and action parameters, bad ASP.NET ViewState, PHP type errors and warnings, Python or Django debug pages, Rails development pages and Node.js unhandled rejections. Capture the resulting trace, file paths, library names and line numbers verbatim.",
    owasp: ["A10:2025", "A02:2025"],
    cwe: ["CWE-209", "CWE-200", "CWE-756"],
    tools: ["send_to_burp_intruder", "curl", "search_burp_proxy_history", "ffuf"],
    evidence: "The full stack trace response, saved or screenshotted, with paths, framework versions and line numbers highlighted.",
  },  {
    id: "WSTG-CRYP-01",
    section: "4.9.1",
    category: "CRYP",
    title: "Testing for Weak Transport Layer Security",
    objective:
      "Prove that the TLS configuration permits weak protocols, ciphers or certificate conditions that undermine confidentiality.",
    howToTest:
      "Enumerate the protocols and cipher suites every host and port offers (nmap ssl-enum-ciphers plus scripted handshakes), checking for SSLv2/v3, TLS 1.0 and 1.1, RC4, 3DES, export and NULL ciphers, weak DH groups, expired or misnamed certificates, missing intermediates and insecure renegotiation. Confirm exploitability of the weakest accepted primitive rather than only listing it.",
    owasp: ["A04:2025", "A02:2025"],
    cwe: ["CWE-326", "CWE-327", "CWE-295"],
    tools: ["nmap", "run_python_script", "curl", "jq"],
    evidence: "Per-host protocol and cipher enumeration output with the certificate details and the specific weak suite that was accepted.",
  },
  {
    id: "WSTG-CRYP-02",
    section: "4.9.2",
    category: "CRYP",
    title: "Testing for Padding Oracle",
    objective:
      "Prove that the application leaks whether padding is valid, enabling decryption or forgery of encrypted values.",
    howToTest:
      "Locate encrypted, unauthenticated values such as cookies, ViewState, tokens or identifiers, then flip bytes in the final ciphertext block and score responses for distinct error text, status codes, redirects or timing that separate bad padding from bad data. Automate the differential with a script and confirm by recovering a known plaintext block.",
    owasp: ["A04:2025", "A10:2025"],
    cwe: ["CWE-209", "CWE-347", "CWE-649"],
    tools: ["send_to_burp_intruder", "run_python_script", "send_to_burp_repeater", "jq"],
    evidence: "The distinguishing responses or timing distribution for valid versus invalid padding plus one recovered plaintext block.",
  },
  {
    id: "WSTG-CRYP-03",
    section: "4.9.3",
    category: "CRYP",
    title: "Testing for Sensitive Information Sent via Unencrypted Channels",
    objective:
      "Prove that sensitive data crosses the network in clear text or with weak protection.",
    howToTest:
      "Search all captured traffic for credentials, tokens, personal data and session identifiers sent over http:// or over non-TLS protocols such as SMTP, IMAP, LDAP and FTP, and inspect mixed-content resources and third-party calls that carry sensitive values. Check whether the data is merely base64 encoded rather than encrypted.",
    owasp: ["A04:2025", "A02:2025"],
    cwe: ["CWE-319", "CWE-311", "CWE-522"],
    tools: ["search_burp_proxy_history", "curl", "nmap", "jq"],
    evidence: "The plain-text request containing the sensitive value, with its scheme and destination host, or the mixed-content reference.",
  },
  {
    id: "WSTG-CRYP-04",
    section: "4.9.4",
    category: "CRYP",
    title: "Testing for Weak Encryption",
    objective:
      "Prove that the application uses broken algorithms, custom crypto or hard-coded keys for sensitive data.",
    howToTest:
      "Identify every encrypted or encoded value in tokens, cookies, files and configuration, then classify the scheme: ECB mode or fixed IVs, static salts, unsalted MD5/SHA-1 hashes, ROT13 or base64-only obfuscation and home-grown XOR. Attempt practical attacks such as hash lookup, key reuse between environments and offline brute force.",
    owasp: ["A04:2025", "A07:2025"],
    cwe: ["CWE-327", "CWE-328", "CWE-916"],
    tools: ["run_python_script", "search_burp_proxy_history", "send_to_burp_repeater", "jq"],
    evidence: "The algorithm and format identified for each value, plus the cracked hash or recovered plaintext that demonstrates impact.",
  },
  {
    id: "WSTG-BUSL-01",
    section: "4.10.1",
    category: "BUSL",
    title: "Test Business Logic Data Validation",
    objective:
      "Prove that business data reaches storage without server-side validation of range, type or consistency.",
    howToTest:
      "Send logically impossible values to every business field: negative or zero quantities and prices, huge numbers, dates in the past or far future, reversed start and end pairs, mismatched currency or unit, and unexpected extra fields. Verify what is persisted and how downstream processes, totals and reports react.",
    owasp: ["A06:2025", "A08:2025"],
    cwe: ["CWE-20", "CWE-1284", "CWE-1173"],
    tools: ["send_to_burp_repeater", "run_python_script", "send_to_burp_intruder", "jq"],
    evidence: "Request/response pair showing the impossible value accepted together with the persisted state read back from the application.",
  },
  {
    id: "WSTG-BUSL-02",
    section: "4.10.2",
    category: "BUSL",
    title: "Test Ability to Forge Requests",
    objective:
      "Prove that business requests can be crafted directly, bypassing the sequence and state the UI assumes.",
    howToTest:
      "Rebuild critical requests from scratch without the browser, dropping, reordering or repeating the steps of a multi-stage flow, and modify hidden fields, prices, quantities, ids and tokens. Call internal APIs directly to determine whether the server validates the flow or trusts whatever the client sends.",
    owasp: ["A06:2025", "A01:2025"],
    cwe: ["CWE-602", "CWE-841", "CWE-472"],
    tools: ["send_to_burp_repeater", "curl", "run_python_script", "jq"],
    evidence: "The forged request and the accepted business outcome (order, credit or state change) that the UI flow would have prevented.",
  },
  {
    id: "WSTG-BUSL-03",
    section: "4.10.3",
    category: "BUSL",
    title: "Test Integrity Checks",
    objective:
      "Prove that integrity controls on client-supplied data can be bypassed, replayed or are simply absent.",
    howToTest:
      "Locate signed or hashed fields (HMACs, checksums, serialised state, signed cookies and tokens), then test whether the signature is verified at all: strip it, reuse a signature from another message, alter the payload while keeping the signature, replay an old message, and probe algorithm confusion, none-alg and length-extension behaviour.",
    owasp: ["A08:2025", "A06:2025"],
    cwe: ["CWE-345", "CWE-353", "CWE-347"],
    tools: ["send_to_burp_repeater", "run_python_script", "send_to_burp_intruder", "jq"],
    evidence: "Request/response pairs for the tampered or replayed message accepted as valid, alongside the original signed message.",
  },
  {
    id: "WSTG-BUSL-04",
    section: "4.10.4",
    category: "BUSL",
    title: "Test for Process Timing",
    objective:
      "Prove that timing differences or concurrency windows in a business process can be exploited.",
    howToTest:
      "Measure response times for user enumeration, token or OTP comparison, coupon validation and expensive operations to find statistically significant leaks, then race critical sections by firing simultaneous requests (single-packet or high-concurrency bursts) to win a time-of-check to time-of-use window on limits, balances or votes.",
    owasp: ["A06:2025", "A10:2025"],
    cwe: ["CWE-208", "CWE-362", "CWE-367"],
    tools: ["run_python_script", "send_to_burp_intruder", "jq"],
    evidence: "Timing distribution tables for valid versus invalid input, or parallel-request output showing the duplicated business effect.",
  },
  {
    id: "WSTG-BUSL-05",
    section: "4.10.5",
    category: "BUSL",
    title: "Test Number of Times a Function Can Be Used Limits",
    objective:
      "Prove that usage limits on expensive or abusable functions are missing or bypassable.",
    howToTest:
      "Identify functions with an intended limit (vouchers, OTPs, password resets, invitations, votes, API quotas, downloads) and exceed it deliberately, then bypass the counter with parallel requests, parameter variations, session or IP rotation, alternating accounts and resetting the counter through a successful action or a new session.",
    owasp: ["A09:2025", "A06:2025"],
    cwe: ["CWE-799", "CWE-770", "CWE-307"],
    tools: ["send_to_burp_intruder", "run_python_script", "jq"],
    evidence: "A log of successful uses beyond the documented limit plus the request pattern that bypassed the counter.",
  },  {
    id: "WSTG-BUSL-06",
    section: "4.10.6",
    category: "BUSL",
    title: "Testing for the Circumvention of Work Flows",
    objective:
      "Prove that mandatory workflow steps such as verification, payment, approval or MFA can be skipped while still completing the transaction.",
    howToTest:
      "Walk each multi-step flow, then jump straight to later steps, go back and change earlier inputs, submit steps out of order or twice, force-browse to the completion handler, and cancel or retry mid-flow. Check whether the server enforces order and state or trusts the client's sequence.",
    owasp: ["A06:2025", "A01:2025"],
    cwe: ["CWE-841", "CWE-602", "CWE-696"],
    tools: ["browser_action", "send_to_burp_repeater", "search_burp_proxy_history", "jq"],
    evidence: "The request sequence that completed the flow without the mandatory step, with the resulting business outcome recorded.",
  },
  {
    id: "WSTG-BUSL-07",
    section: "4.10.7",
    category: "BUSL",
    title: "Test Defenses Against Application Misuse",
    objective:
      "Prove that abusive automation is neither detected, blocked nor alerted on.",
    howToTest:
      "Run visible but non-destructive abusive traffic (rapid enumeration, repeated form submissions, scraping, parameter floods) and observe whether the application rate-limits, blocks, delays, alerts or logs it. Then check whether any block is trivially bypassed by rotating source IPs, user agents or accounts.",
    owasp: ["A09:2025", "A06:2025"],
    cwe: ["CWE-778", "CWE-799"],
    tools: ["send_to_burp_intruder", "run_python_script", "ffuf", "search_burp_proxy_history"],
    evidence: "A traffic log showing sustained misuse without a defensive response, plus any alerts or log entries the application produced.",
  },
  {
    id: "WSTG-BUSL-08",
    section: "4.10.8",
    category: "BUSL",
    title: "Test Upload of Unexpected File Types",
    objective:
      "Prove that the upload feature accepts file types it should reject, including server-executable formats.",
    howToTest:
      "Upload unexpected extensions (php, phtml, jsp, jspx, aspx, exe, sh, htaccess) with double extensions, mixed case, trailing dots or spaces, null bytes and image-plus-script names, and spoof the Content-Type and magic bytes. Then check how the stored file is served, converted or executed.",
    owasp: ["A06:2025", "A05:2025"],
    cwe: ["CWE-434", "CWE-646"],
    tools: ["send_to_burp_repeater", "send_to_burp_intruder", "ffuf", "curl"],
    evidence: "The accepted file's stored path and the response proving the type restriction was bypassed or the file executes.",
  },
  {
    id: "WSTG-BUSL-09",
    section: "4.10.9",
    category: "BUSL",
    title: "Test Upload of Malicious Files",
    objective:
      "Prove that malicious content inside allowed file types is not detected or neutralised.",
    howToTest:
      "Embed payloads inside permitted formats: polyglot images carrying script, macros in Office and ODF documents, XXE or SSRF in SVG and DOCX, JavaScript in PDF, .htaccess files, archives with traversal or symlink entries and an EICAR test file for antivirus baselining. Check upload, storage, scanning, preview, conversion and download paths in turn.",
    owasp: ["A06:2025", "A08:2025"],
    cwe: ["CWE-434", "CWE-409", "CWE-646"],
    tools: ["run_python_script", "send_to_burp_repeater", "curl", "search_burp_proxy_history"],
    evidence: "The uploaded malicious file with its payload intact, plus the preview or download response showing it is served or executed.",
  },
  {
    id: "WSTG-CLNT-01",
    section: "4.11.1",
    category: "CLNT",
    title: "Testing for DOM-Based Cross Site Scripting",
    objective:
      "Prove that client-side JavaScript writes attacker-controlled data into a dangerous DOM sink.",
    howToTest:
      "Instrument the browser to trace sources (location.hash, search, document.referrer, postMessage, storage, cookies) into sinks (innerHTML, document.write, insertAdjacentHTML, eval, jQuery html(), location assignment). Feed controlled values into each source and confirm execution with a breakpoint or a payload that proves impact.",
    owasp: ["A05:2025", "A06:2025"],
    cwe: ["CWE-79"],
    tools: ["browser_action", "search_burp_proxy_history", "run_python_script", "view_image"],
    evidence: "The source-to-sink trace, console output or breakpoint screenshot, with the payload that executed in the DOM recorded.",
  },
  {
    id: "WSTG-CLNT-02",
    section: "4.11.2",
    category: "CLNT",
    title: "Testing for JavaScript Execution",
    objective:
      "Prove that attacker-supplied input is executed as JavaScript in the browser, including through non-obvious vectors.",
    howToTest:
      "Test every input that can end up interpreted as script: JSONP callbacks, redirect parameters, eval-based flows, script gadgets in libraries, SVG and HTML uploads, postMessage handlers and WebSocket payloads. Use exotic execution paths such as data:, javascript: and blob: URLs and framework-specific sanitiser bypasses.",
    owasp: ["A05:2025"],
    cwe: ["CWE-79", "CWE-83"],
    tools: ["browser_action", "send_to_burp_repeater", "view_image", "run_python_script"],
    evidence: "Screenshot or console log of the executed script with the payload and the URL or request that delivered it.",
  },
  {
    id: "WSTG-CLNT-03",
    section: "4.11.3",
    category: "CLNT",
    title: "Testing for HTML Injection",
    objective:
      "Prove that unescaped input is rendered as HTML, allowing content or interface spoofing even without script execution.",
    howToTest:
      "Inject markup (headings, links, forms, iframes, images with onerror-less attributes) into reflected and stored inputs and check whether it renders. Then assess impact: credential phishing forms, defacement, meta-refresh redirects and injection into e-mail previews or PDF exports.",
    owasp: ["A05:2025"],
    cwe: ["CWE-79", "CWE-80"],
    tools: ["browser_action", "send_to_burp_repeater", "view_image", "search_burp_proxy_history"],
    evidence: "Screenshot of the rendered injected HTML, ideally a convincing phishing form, with the request that delivered it.",
  },
  {
    id: "WSTG-CLNT-04",
    section: "4.11.4",
    category: "CLNT",
    title: "Testing for Client-side URL Redirect",
    objective:
      "Prove that a client-side redirect or navigation sink can send users to an attacker-controlled destination.",
    howToTest:
      "Fuzz redirect targets in hash fragments, url and next parameters, JavaScript navigation sinks and OAuth or SSO return URLs, testing absolute URLs, protocol-relative // forms, backslash and encoded variants and userinfo tricks such as a trusted host before an @ sign. Confirm the browser actually navigates off-site.",
    owasp: ["A01:2025", "A05:2025"],
    cwe: ["CWE-601", "CWE-79"],
    tools: ["browser_action", "send_to_burp_intruder", "view_image", "search_burp_proxy_history"],
    evidence: "The final browser URL or screenshot showing navigation to the external domain, plus the parameter and payload used.",
  },  {
    id: "WSTG-CLNT-05",
    section: "4.11.5",
    category: "CLNT",
    title: "Testing for CSS Injection",
    objective:
      "Prove that injected CSS can alter the page or exfiltrate data through style-based side channels.",
    howToTest:
      "Inject style blocks, style attributes and url() values into reflected and stored inputs, then escalate: attribute selectors with background-image requests to leak input values or CSRF tokens, @import of an attacker stylesheet, and UI redressing of sensitive forms. Confirm the callback to the collaborator endpoint carrying the targeted value.",
    owasp: ["A05:2025", "A01:2025"],
    cwe: ["CWE-79"],
    tools: ["send_to_burp_repeater", "browser_action", "burp_collaborator", "view_image"],
    evidence: "Screenshot of the altered interface plus the collaborator or style request that leaked the targeted value.",
  },
  {
    id: "WSTG-CLNT-06",
    section: "4.11.6",
    category: "CLNT",
    title: "Testing for Client-side Resource Manipulation",
    objective:
      "Prove that client-side code loads or rewrites resources from a source the attacker can control.",
    howToTest:
      "Enumerate dynamically loaded resources (script and img sources, iframes, stylesheets, web workers, service workers, manifests, import maps) and test whether the URL, path or parameter can be influenced to load attacker content. Check for missing Subresource Integrity on third-party scripts and for relative-path or open-redirect based sourcing.",
    owasp: ["A03:2025", "A05:2025"],
    cwe: ["CWE-830", "CWE-79", "CWE-353"],
    tools: ["browser_action", "search_burp_proxy_history", "run_python_script", "send_to_burp_repeater"],
    evidence: "The rewritten resource request loading external content, captured in the proxy history, and the missing integrity attribute.",
  },
  {
    id: "WSTG-CLNT-07",
    section: "4.11.7",
    category: "CLNT",
    title: "Testing Cross Origin Resource Sharing",
    objective:
      "Prove that the CORS policy allows untrusted origins to read authenticated responses.",
    howToTest:
      "Send requests with a range of Origin values (attacker domain, null, sibling subdomains, http:// and suffix or prefix variations) and inspect Access-Control-Allow-Origin, Allow-Credentials and Vary. Then verify with a real cross-origin fetch from a controlled page whether the response body is readable.",
    owasp: ["A01:2025", "A02:2025"],
    cwe: ["CWE-942", "CWE-346"],
    tools: ["send_to_burp_repeater", "browser_action", "run_python_script", "search_burp_proxy_history"],
    evidence: "Response headers reflecting the attacker origin with credentials allowed, plus the cross-origin read demonstrated in a browser page.",
  },
  {
    id: "WSTG-CLNT-08",
    section: "4.11.8",
    category: "CLNT",
    title: "Testing for Cross Site Flashing",
    objective:
      "Prove that legacy Flash/Flex components expose cross-site scripting, cross-domain access or data leakage.",
    howToTest:
      "Detect SWF assets and debugger-enabled builds, decompile them to find unsafe ExternalInterface, loadPolicyFile and getURL usage plus hard-coded endpoints and credentials, then test allowScriptAccess and crossdomain.xml interactions for script execution or cross-origin data reads.",
    owasp: ["A02:2025", "A05:2025"],
    cwe: ["CWE-79", "CWE-942"],
    tools: ["run_python_script", "browser_action", "curl", "view_image"],
    evidence: "The decompiled SWF snippet with the unsafe call, or a screenshot of script execution from a cross-domain SWF.",
  },
  {
    id: "WSTG-CLNT-09",
    section: "4.11.9",
    category: "CLNT",
    title: "Testing for Clickjacking",
    objective:
      "Prove that the application's pages can be framed by another origin and used for interface redressing.",
    howToTest:
      "Build a proof-of-concept page that frames the target and check whether the browser renders it, then test framebusting bypasses (double framing, the sandbox attribute, about:blank, cancelling onBeforeUnload). Review X-Frame-Options and CSP frame-ancestors for gaps and inconsistent coverage across hosts and paths.",
    owasp: ["A02:2025", "A06:2025"],
    cwe: ["CWE-1021", "CWE-346"],
    tools: ["browser_action", "view_image", "search_burp_proxy_history", "run_python_script"],
    evidence: "Screenshot of the framed target performing a sensitive action from the proof-of-concept origin, with the framing headers shown.",
  },  {
    id: "WSTG-CLNT-10",
    section: "4.11.10",
    category: "CLNT",
    title: "Testing WebSockets",
    objective:
      "Prove that the WebSocket channel is not protected against cross-site use, injection or unauthorised message handling.",
    howToTest:
      "Estimate the data exchanged, then test the handshake for Origin validation, cookie-based authentication, arbitrary subprotocols and protocol version handling. Replay and tamper with messages, including binary and fragmented frames, to check server-side validation, and finish with a cross-site WebSocket hijacking proof of concept.",
    owasp: ["A05:2025", "A01:2025"],
    cwe: ["CWE-1385", "CWE-346"],
    tools: ["browser_action", "run_python_script", "search_burp_proxy_history"],
    evidence: "The handshake and message frames, including a tampered frame the server accepted, or the cross-site hijacking output.",
  },
  {
    id: "WSTG-CLNT-11",
    section: "4.11.11",
    category: "CLNT",
    title: "Testing Web Messaging",
    objective:
      "Prove that postMessage handlers trust messages from any origin or act on unvalidated message data.",
    howToTest:
      "Enumerate message listeners with browser instrumentation, then send crafted messages from an attacker origin with tampered payloads to see whether a handler executes actions, injects markup or leaks data. Also check whether the application itself posts sensitive data with a wildcard target origin.",
    owasp: ["A01:2025", "A05:2025"],
    cwe: ["CWE-346", "CWE-79", "CWE-1385"],
    tools: ["browser_action", "run_python_script", "view_image", "search_burp_proxy_history"],
    evidence: "The console or network trace of the tampered message causing a state change or script execution, plus the responsible handler code.",
  },
  {
    id: "WSTG-CLNT-12",
    section: "4.11.12",
    category: "CLNT",
    title: "Testing Browser Storage",
    objective:
      "Prove that sensitive data held in browser storage is exposed to other origins or persists beyond its usefulness.",
    howToTest:
      "Inspect localStorage, sessionStorage, IndexedDB, Web SQL, cookies and cache for tokens, credentials and personal data, then test whether stored values are trusted (used for authorisation or injected into the DOM) and whether they survive logout, password change or session expiry. Check for origin sharing and XSS reach.",
    owasp: ["A07:2025", "A02:2025"],
    cwe: ["CWE-922", "CWE-539", "CWE-312"],
    tools: ["browser_action", "run_python_script", "search_burp_proxy_history", "jq"],
    evidence: "An excerpt of the stored value with its storage key and origin, plus proof it survives logout or is trusted by the server.",
  },
  {
    id: "WSTG-CLNT-13",
    section: "4.11.13",
    category: "CLNT",
    title: "Testing for Cross Site Script Inclusion",
    objective:
      "Prove that sensitive data can be read cross-origin by including the application's own script responses.",
    howToTest:
      "Find script responses that embed user-specific data (dynamic JavaScript, JSONP, JSON or CSV served as script) and include them from an attacker page via a script tag. Read the data through side channels: global variable access, callback or prototype hijacking, error-message leakage and charset tricks, checking that SameSite, CORS and Subresource Integrity do not block it.",
    owasp: ["A01:2025", "A03:2025", "A08:2025"],
    cwe: ["CWE-346", "CWE-200", "CWE-353"],
    tools: ["browser_action", "run_python_script", "search_burp_proxy_history", "view_image"],
    evidence: "The attacker page reading the victim's data (console output) plus the included script response that contained it.",
  },
  {
    id: "WSTG-APIT-01",
    section: "4.12.1",
    category: "APIT",
    title: "Testing GraphQL",
    objective:
      "Prove that the GraphQL endpoint exposes introspection, unbounded queries or field-level authorisation gaps.",
    howToTest:
      "Probe candidate endpoints (/graphql, /api/graphql, /v1/graphql) with GET and POST and run introspection, falling back to field-suggestion brute force when introspection is disabled. Then test query depth and cost limits, batching and aliasing for rate-limit bypass, mutation authorisation on every field, and error messages for schema disclosure.",
    owasp: ["A01:2025", "A05:2025"],
    cwe: ["CWE-284", "CWE-863", "CWE-770"],
    tools: ["curl", "send_to_burp_repeater", "send_to_burp_intruder", "jq"],
    evidence: "The introspection result or reconstructed schema plus the query that returned data the caller was not authorised to read.",
  },
];