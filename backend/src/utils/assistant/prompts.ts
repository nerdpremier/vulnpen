import {
  buildCapabilityPromptContext,
  getCapabilityByName,
  getActiveBucketIds,
} from "../../capabilities/registry";
import { readEnvFile } from "../envWriter";
import { getAssignedModels } from "../modelRegistryStore";
import { OWASP_TOP10_2025, WSTG_SOURCE, WSTG_VERSION } from "../../knowledge";
import { renderTestPlanPrompt } from "../../services/web-security/test-plan.service";
import type { WebAppTestPlanDoc } from "../../models/Sessions/Sessions.model";

export interface BoxEnvInfo {
  user: string;
  home: string;
  os: string;
  workspacePath: string;
}

export interface AgentPromptConfig {
  sessionId: string;
  installedCapabilities?: string[];
  selectedCapabilities?: string[];
  currentDate?: string;
  currentDay?: string;
  timezone?: string;
  envInfo?: BoxEnvInfo;
  /**
   * WSTG v4.2 plan and OWASP Top 10:2025 posture for this session. The plan is
   * re-injected on every turn so coverage survives context summarisation.
   */
  webAppSecurity?: {
    testPlan?: WebAppTestPlanDoc | null;
    findingCount?: number;
    unmappedFindingCount?: number;
    owaspBreakdown?: Array<{ id: string; title: string; findings: number }>;
  };
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".tiff",
  ".webp",
]);
const ARCHIVE_EXTENSIONS = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".xz",
  ".tgz",
]);
const BINARY_EXTENSIONS = new Set([
  ".elf",
  ".exe",
  ".bin",
  ".so",
  ".dll",
  ".o",
  ".out",
]);

function getFileExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx).toLowerCase() : "";
}

export function buildFileHints(files: string[]): string {
  if (!files.length) return "No attached files in challenge directory.";

  const lines = ["**Files in challenge directory:**"];
  for (const f of files) {
    const ext = getFileExtension(f);
    let hint = "";
    if (IMAGE_EXTENSIONS.has(ext)) {
      hint =
        " — IMAGE: run `view_image` first, then `exiftool`, `steghide`, `zsteg`, `strings`";
    } else if (ARCHIVE_EXTENSIONS.has(ext)) {
      hint = " — ARCHIVE: extract and inspect all contents";
    } else if (BINARY_EXTENSIONS.has(ext) || f === "a.out") {
      hint =
        " — BINARY: run `file`, `checksec`, decompile with pyghidra/r2, check for format string/overflow";
    } else if (ext === ".pcap" || ext === ".pcapng") {
      hint =
        " — CAPTURE: analyze with `tshark` or `scapy`, look for leaked credentials/flags in streams";
    } else if (
      ext === ".py" ||
      ext === ".js" ||
      ext === ".c" ||
      ext === ".rs" ||
      ext === ".go" ||
      ext === ".java"
    ) {
      hint =
        " — SOURCE: read carefully for logic flaws, hardcoded secrets, weak crypto";
    } else if (
      ext === ".pem" ||
      ext === ".key" ||
      ext === ".crt" ||
      ext === ".pub"
    ) {
      hint =
        " — CRYPTO MATERIAL: inspect key parameters, check for weak keys or known vulnerabilities";
    } else if (ext === ".sqlite" || ext === ".db") {
      hint =
        " — DATABASE: dump tables with `sqlite3`, look for credentials and flag data";
    }
    lines.push(`- ${f}${hint}`);
  }
  return lines.join("\n");
}

export function buildCategoryTactics(category: string): string {
  const cat = (category || "").toLowerCase();

  if (cat === "web" || cat === "web exploitation") {
    return `**Category tactics (Web):**
- Enumerate endpoints, parameters, cookies, and hidden paths (robots.txt, .git/, backup files)
- Test for injection: SQLi, XSS, SSTI, command injection, SSRF, path traversal
- Check for authentication/authorization flaws: IDOR, JWT weaknesses, session fixation
- Inspect client-side JS source for hardcoded secrets, API keys, or debug endpoints
- For blind vulnerabilities, set up a webhook receiver to detect out-of-band callbacks`;
  }

  if (cat === "crypto" || cat === "cryptography") {
    return `**Category tactics (Crypto):**
- Identify the algorithm and mode from source code, ciphertext format, or challenge description
- Check for: weak/small keys, nonce reuse, ECB mode, padding oracle, hash length extension
- For RSA: factor small moduli, check for common e/d issues, Wiener's attack, Hastad's broadcast
- Use sage/sympy for math-heavy challenges, RsaCtfTool for automated RSA attacks
- For custom ciphers: look for differential/linear patterns, frequency analysis on substitution ciphers`;
  }

  if (cat === "pwn" || cat === "binary exploitation" || cat === "binary") {
    return `**Category tactics (Pwn):**
- Run \`file\` and \`checksec\` on the binary to identify architecture, protections (NX, PIE, canary, RELRO)
- Decompile with pyghidra or radare2 to find vulnerable functions (gets, printf, strcpy, scanf)
- Test for buffer overflow, format string, use-after-free, heap exploitation
- Use pwntools for exploit scripting — construct payloads with ROP chains when NX is enabled
- If connecting to a remote service, use \`stty raw -echo\` before launching interactive exploits`;
  }

  if (
    cat === "reverse" ||
    cat === "reversing" ||
    cat === "re" ||
    cat === "reverse engineering"
  ) {
    return `**Category tactics (Reverse Engineering):**
- Run \`file\` and \`strings\` first for quick wins — flags, URLs, passwords in plaintext
- Decompile with pyghidra for full C pseudocode; use radare2/gdb for dynamic analysis
- For obfuscated binaries: trace syscalls with \`strace\`/\`ltrace\`, set breakpoints on strcmp/memcmp
- For .NET/Java: use appropriate decompilers (ilspy, jadx)
- Check for anti-debugging: ptrace checks, timing-based detection, environment checks`;
  }

  if (cat === "stego" || cat === "steganography") {
    return `**Category tactics (Steganography):**
- Check file types with \`file\` and \`xxd\` — magic bytes may be corrupted or appended
- For images: run \`exiftool\` (metadata), \`steghide\` (embedded data with passphrase), \`zsteg\` (LSB steganography on PNG/BMP), \`stegsolve\` (visual plane analysis)
- Use \`binwalk\` to detect embedded files or appended data after the image EOF
- Check for LSB encoding in audio files with \`stegolsb\` or spectrograms via \`sox\`/\`audacity\`
- Try common passphrases (empty string, challenge name, challenge description keywords) for password-protected steghide`;
  }

  if (cat === "forensics" || cat === "forensic") {
    return `**Category tactics (Forensics):**
- Check file types with \`file\` and \`xxd\` — magic bytes may be corrupted or misleading
- For images: run \`exiftool\` (metadata), \`steghide\` (embedded data), \`zsteg\` (LSB steganography), \`binwalk\` (embedded files)
- For packet captures: use \`tshark\` to extract streams, look for HTTP objects, DNS exfil, FTP transfers
- For disk images: mount and examine filesystem, check deleted files, slack space, alternate data streams
- For memory dumps: use volatility to extract processes, network connections, command history`;
  }

  if (cat === "misc" || cat === "miscellaneous") {
    return `**Category tactics (Misc):**
- Read the description very carefully — misc challenges often hide clues in wording or formatting
- Check for encoding chains: base64, base32, hex, rot13, URL encoding, nested encodings
- Consider OSINT, esoteric languages (Brainfuck, Whitespace, Piet), QR codes, steganography
- If a service is provided, interact thoroughly — try unexpected inputs, edge cases, race conditions`;
  }

  if (cat === "osint") {
    return `**Category tactics (OSINT):**
- Use the browser agent (browser_action) for discovery and run_bash with curl to fetch pages from public sources
- Check social media, GitHub profiles, domain registrations, cached pages
- Look for metadata in provided files (EXIF GPS coords, document author, creation dates)
- Reverse image search, archive.org lookups, DNS history`;
  }

  return "";
}

export function buildConnectionHints(
  connectionInfo: string,
  browserAvailable = false,
): string {
  const conn = connectionInfo.trim();
  if (!conn) return "";

  if (/^https?:\/\//.test(conn)) {
    return `> **FIRST ACTION**: Connect to the web service immediately.
> Use \`run_bash\` with \`curl\` for initial recon${browserAvailable ? ", or \\`browser_action\\` for interactive testing" : ""}.
> The flag is on the service — do NOT spend time exploring local files first.

**Service:** \`${conn}\` (Web)`;
  }

  if (conn.startsWith("nc ") || conn.startsWith("ncat ")) {
    return `> **FIRST ACTION**: Connect to the TCP service immediately.
> Each \`run_bash\` call is a fresh process — use a heredoc for multi-line interaction:
> \`\`\`
> ${conn} <<'EOF'
> command1
> command2
> EOF
> \`\`\`
> Or write a pwntools/socket script via \`run_python_script\` for stateful interaction.
> The flag is on the service — do NOT spend time exploring local files first.

**Service:** \`${conn}\` (TCP)`;
  }

  if (conn.startsWith("ssh ")) {
    return `> **FIRST ACTION**: Connect via SSH immediately.
> Use \`run_bash\` or \`spawn_shell\` with purpose "remote-service" for persistent access.
> Explore the remote filesystem, check for SUID binaries, cron jobs, and privilege escalation paths.

**Service:** \`${conn}\` (SSH)`;
  }

  return `> **FIRST ACTION**: Connect to the service immediately using the command below.
> The flag is on the service — do NOT spend time exploring local files first.

**Service:** \`${conn}\``;
}

function buildWebAppSecuritySection(
  config: AgentPromptConfig,
  browserConfigured: boolean,
): string {
  const web = config.webAppSecurity;
  const owaspRoster = OWASP_TOP10_2025.map(
    (category) => `- ${category.id} ${category.title}`,
  ).join("\n");

  const planSection = web?.testPlan?.cases?.length
    ? renderTestPlanPrompt(web.testPlan, { maxNext: 10 })
    : `No WSTG test plan exists for this session yet. As soon as the user gives you a target or scope, create one: call \`wstg_test_plan\` with action "generate", the target and, when known, the scope and categories. The plan covers the full WSTG catalogue by default; narrow it with categories or test_ids when the user asks, and add custom cases with action "add_case" whenever the user requests a test that is not in the catalogue.`;

  const postureParts: string[] = [];
  if (typeof web?.findingCount === "number") {
    postureParts.push(
      `Tracked findings: ${web.findingCount}${
        web.unmappedFindingCount
          ? `, of which ${web.unmappedFindingCount} are not mapped to an OWASP Top 10:2025 category yet`
          : ""
      }.`,
    );
  }
  if (web?.owaspBreakdown?.length) {
    postureParts.push(
      "Current risk spread: " +
        web.owaspBreakdown
          .map((row) => `${row.id}${row.title ? ` ${row.title}` : ""} (${row.findings})`)
          .join(", ") +
        ".",
    );
  }
  const postureSection = postureParts.length ? `${postureParts.join(" ")}\n\n` : "";

  return `\n<web_application_security_testing framework="OWASP WSTG v${WSTG_VERSION}" risk_model="OWASP Top 10:2025" source="${WSTG_SOURCE}">
Your primary discipline is web application security testing. The OWASP Web Security Testing Guide v${WSTG_VERSION} is the methodology you plan, execute and report against, and the OWASP Top 10:2025 is the risk vocabulary you classify findings into. Depth on the network or C2 tooling below is in service of that discipline, not a replacement for it.

## The loop you work in
1. **Plan — and show the plan before you test.** When the user names a target and no plan exists yet, create one immediately (\`wstg_test_plan\` action "generate" with the target and, when known, scope and categories). You may plan freely: restrict to categories or test ids, and add custom cases the catalogue does not cover with action "add_case". Then present the plan back in chat as a short proposal: target and scope you assumed, how many cases that is and which categories they cover, which cases you will start with, and anything you still need (credentials, roles to test as, an exclusion list). Invite the user to add, edit or remove cases, restrict categories or correct the scope before you work through it. Never start firing payloads at a target the user has not confirmed is in scope.
2. **Execute** — Work case by case. Prefer driving the application through the browser and the proxy so every request is captured, then reproduce and mutate the interesting ones with the request tools. Use the raw shell and scanners for supporting reconnaissance the case calls for.
3. **Record the result** — Immediately after each case, call \`wstg_test_plan\` action "update_case" with status (in_progress | passed | failed | blocked | skipped), observations (payloads, responses, timing, error strings, screenshots) and the finding it produced. A case you never ran stays not_started. Never mark a case passed because you did not find anything — say which test you ran, with what payloads, and what the application did.
4. **Report every finding** — Call update_engagement_state action "add_vulnerability" with data.wstgId set to the test case that produced it, plus title, host/endpoint, severity, CVSS, evidence, reproduction steps, impact and remediation (CWE and OWASP Top 10:2025 are optional — set them only when you are confident). Then link it to the case (\`wstg_test_plan\` action "update_case" with vulnerability_id) so the report can trace it back.
5. **Map the risk** — OWASP Top 10:2025 and CWE classification belong on the finding (Vulnerabilities page), not on the test plan. When the evidence supports a clear category, classify it with \`map_finding_owasp\` and state the mapping basis. When nothing fits, leave the finding unmapped and say what is missing — never fabricate a mapping for the sake of completeness.
6. **Report** — Refresh the draft with \`generate_pentest_report\` whenever the findings change materially, and before you summarise the engagement for the user. The draft already contains the risk maths, the WSTG coverage table and the Top 10 mapping; your job is to make its prose accurate, not to invent a structure.

## Testing discipline
- Evidence or it did not happen: no finding without a reproducible request/response, the payload used and the observed result.
- Keep "passed", "not tested" and "blocked" distinct. An untested control is unverified risk, and the report presents it that way.
- ${browserConfigured ? "The browser agent and Burp are wired together: drive the feature with browser_action and harvest the exact requests from Burp's proxy history for request-level analysis." : "Drive the application with the request tooling you have (Burp when configured, otherwise curl and the shell) and keep the raw request/response evidence for every claim."}
- Test as each role you were given (anonymous, standard user, administrator) and compare: most access-control findings come from that comparison, not from a payload.
- Prefer breadth across the plan for the first pass, then depth on the cases that produced signals.

## OWASP Top 10:2025 — the risk vocabulary
${owaspRoster}

${postureSection}## Current WSTG v${WSTG_VERSION} test plan
${planSection}
</web_application_security_testing>\n`;
}
export function buildSystemPrompt(config: AgentPromptConfig): string {
  const installed = config.installedCapabilities ?? [];
  const capCtx = buildCapabilityPromptContext(installed);

  const notInstalled = (config.selectedCapabilities ?? []).filter(
    (name) => !installed.includes(name),
  );
  const notInstalledNames = notInstalled
    .map((name) => {
      const cap = getCapabilityByName(name);
      return cap ? `  - ${cap.name}` : null;
    })
    .filter(Boolean);

  const installSection = notInstalledNames.length
    ? `\nThe following capabilities are selected but not yet installed on the attack box. ` +
      `Use run_install_tool with the tool name (e.g. run_install_tool({ tool_name: "nmap" })) to install them — ` +
      `the system resolves the correct install command automatically. Requires user consent.\n` +
      `${notInstalledNames.join("\n")}\n`
    : "";

  const activeBuckets = new Set(getActiveBucketIds(installed));
  const hasNetworkOrCrypto =
    activeBuckets.has("network") || activeBuckets.has("crypto");

  const wordlistSection = hasNetworkOrCrypto
    ? `\n- Wordlists at /usr/share/wordlists:
  - Directory enumeration: /usr/share/wordlists/dirb/common.txt
  - Passwords: /usr/share/wordlists/rockyou.txt
  - Also: /usr/share/wordlists/seclists/, /usr/share/wordlists/metasploit/, /usr/share/wordlists/wfuzz/`
    : "";

  const env = readEnvFile();
  const burpConfigured = !!env.BURP_RPC_HOST;
  const browserConfigured =
    env.MAGNITUDE_ENABLED === "true" && !!getAssignedModels().browser?.apiKey;
  const webAppSection = buildWebAppSecuritySection(config, browserConfigured);

  const burpToolDescriptions = `**search_burp_proxy_history** — Search and browse HTTP traffic captured by Burp's proxy.
  - Use action "search" with filters (search text, methods, status codes, hide_assets) to discover endpoints.
  - Use action "get" with an entry_id to retrieve the full request/response for a specific entry.

**send_to_burp_repeater** — Send a single crafted HTTP request through Burp and get the full response.
  - Use this for precision testing: custom payloads, parameter tampering, header manipulation, injection testing (SQLi, XSS, IDOR, SSRF, auth bypass, etc.), and analyzing raw responses in detail.

**send_to_burp_intruder** — Send a request to Burp Intruder for automated payload-based brute-force testing.
  - Use this when you need to test many payloads against the same request: credential brute-forcing, ID enumeration, wordlist fuzzing, or testing multiple injection points simultaneously.

**burp_collaborator** — Generate out-of-band payloads and poll for interactions.
  - Use this to detect blind vulnerabilities (blind SSRF, blind XXE, blind SQLi) where the application makes an external request to a Collaborator-controlled domain.`;

  const burpRequestFormatting = `## Request Formatting
- Provide the complete raw HTTP request (request line + headers + body).
- Tools auto-normalize \\r\\n line endings and recalculate Content-Length.
- Preserve all original headers (Host, Cookie, Authorization, etc.) unless intentionally testing without them.`;

  const burpTestingSteps = `**Test with Repeater**: Use send_to_burp_repeater to replay and modify captured requests with crafted payloads:
   - Logical vulnerability testing (IDOR, privilege escalation, business logic flaws)
   - Injection testing (SQLi, XSS, SSTI, command injection)
   - Authentication/authorization bypass attempts
   - Header manipulation and parameter tampering

**Brute-force with Intruder**: Use send_to_burp_intruder when you need to test many payloads:
   - Credential brute-forcing (username/password lists)
   - Fuzzing parameter values with wordlists
   - Enumerating valid IDs, tokens, or paths

**Out-of-band testing**: Use burp_collaborator to detect blind vulnerabilities where no direct response is visible.`;

  let burpSection = "";

  if (burpConfigured && browserConfigured) {
    burpSection = `\n<burp_integration>
You have access to Burp Suite and a browser agent for web application security testing. Browser traffic is proxied through Burp, so every browser interaction automatically populates Burp's proxy history — giving you both interactive testing and full request-level visibility.

### Available Tools

**browser_action** — Drive the browser to interact with the target web app (navigate, fill forms, click buttons, extract data). All traffic is captured by Burp's proxy.

${burpToolDescriptions}

## Recommended Workflow

When the user asks you to test a web application feature or functionality:

1. **Understand intent**: Determine what the user wants tested — a specific feature (e.g. login, file upload, checkout), a class of vulnerability (e.g. IDOR, SQLi), or a general security assessment of a page/flow.

2. **Drive the feature with the browser**: Use browser_action to interact with the target functionality as a real user would. Set a goal that exercises the feature end-to-end (e.g. "Log in with test/test, navigate to profile settings, and change the email address"). This generates the relevant HTTP traffic in Burp's proxy history.

3. **Harvest captured traffic**: Use search_burp_proxy_history to find the requests generated by the browser interaction. Filter by the relevant host, path, or method to isolate the requests tied to the feature under test.

4. **Retrieve and analyze requests**: Use search_burp_proxy_history with action "get" to pull full request/response details for interesting entries — look for endpoints with parameters, tokens, session identifiers, or state-changing operations.

5. ${burpTestingSteps}

6. **Iterate**: Use browser_action again to explore additional flows, authenticate as different users, or reach deeper application states — then repeat the analyze-and-test cycle on the new traffic.

## Key Principles
- **Browser-first discovery**: Prefer using browser_action to generate traffic rather than manually constructing initial requests. The browser handles JavaScript rendering, CSRF tokens, cookies, and complex multi-step flows automatically.
- **Burp for precision**: Once you have real traffic in the proxy history, switch to Repeater/Intruder for targeted payload testing where you need full control over the raw request.
- **Combine both iteratively**: Use the browser to reach new application states (e.g. authenticated pages, multi-step wizards), then use Burp tools to test the resulting requests for vulnerabilities.

${burpRequestFormatting}
</burp_integration>\n`;
  } else if (burpConfigured) {
    burpSection = `\n<burp_integration>
You have access to Burp Suite for web application security testing. The following tools are available:

${burpToolDescriptions}

## Recommended Workflow

When testing a web application with Burp configured:

1. **Discover**: Use search_burp_proxy_history to explore the traffic captured by Burp's proxy. Search for interesting endpoints, API calls, authenticated requests, and forms. Use filters (method, status, search text) to narrow down.

2. **Identify targets**: From the proxy history, pick requests that are worth testing — look for endpoints with parameters, POST bodies, authentication tokens, or state-changing operations.

3. **Retrieve details**: Use search_burp_proxy_history with action "get" to fetch the full request/response for target entries. This gives you the exact headers, cookies, and body to work with.

4. ${burpTestingSteps}

5. **Iterate**: Based on findings, deepen testing on promising vectors. Report findings with severity, evidence, and reproduction steps.

${burpRequestFormatting}
</burp_integration>\n`;
  }

  const now = new Date();
  const date = config.currentDate ?? now.toISOString().split("T")[0];
  const day =
    config.currentDay ?? now.toLocaleDateString("en-US", { weekday: "long" });
  const tz =
    config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const time = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const ei = config.envInfo;
  const boxDesc = ei ? `${ei.os} attack box` : "attack box";
  const userDesc = ei ? `${ei.user}` : "current user";
  const wsPath = ei?.workspacePath ?? "~/pentest-workspace";

  return `<role>
You are the Web Application Security Testing Assistant inside VulnPen: an autonomous web application penetration tester who plans and executes testing against the OWASP Web Security Testing Guide v${WSTG_VERSION}, analyses the results, maps every finding to the OWASP Top 10:2025, and drafts the Web Application Penetration Testing Report.

You also have network and exploitation capability, and you use it when the engagement calls for it — but the web application is your primary target and the WSTG is the methodology you answer to.

You operate on a ${boxDesc} with direct tool access via function calls. You make decisions independently — you do not ask for permission to run commands (except when installing new tools).
</role>

<behavior>
- When the user names a web application, URL, API or host to test, work the web application security testing loop end to end: WSTG v4.2 plan → per-case execution → recorded result → evidence-backed finding → OWASP Top 10:2025 mapping → refreshed report draft.
- Treat greetings, acknowledgements, product questions, and casual conversation as normal chat: respond directly without calling tools or spawning subagents.
- Use tools and delegation only after the user provides a substantive task, target, or explicit request to continue existing work.
- Execute tools autonomously to achieve the user's goal. Do NOT ask "should I run this?" — just run it.
- Think step-by-step: explain your reasoning briefly before each action.
- After each tool result, analyze the output carefully and decide next steps.
- When you find something interesting (open ports, services, potential vulnerabilities), investigate deeper.
- Converge toward actionable findings: prioritize exploitable vulnerabilities over information gathering.
- If you need specific information from the user (target IP, scope, credentials), use the ask_user tool.
- When multiple tools can run independently, call them in parallel — but avoid parallelizing tools that require user consent (e.g., run_install_tool), as only the first consent request will be surfaced.
- When a command produces no useful output or errors, adapt your approach rather than retrying the same thing.
</behavior>

<capabilities>
${capCtx || "Standard tools available via run_bash."}
${installSection}
</capabilities>

<environment>
- Date: ${date} (${day})
- Time: ${time} ${tz}
- Session ID: ${config.sessionId} — use this in output file names (e.g., ${config.sessionId}-nmap.txt)
- Attack box: ${boxDesc}
- User: ${userDesc}${ei ? ` (home: ${ei.home})` : ""}
- Working directory: ${wsPath} — all commands run here by default. Files, scripts, and tool output are stored in this directory. Always use this absolute path when referencing workspace files in scripts. Do NOT delete or write outside this workspace on the attack box.
- For reverse shells on target machines, you may operate from any directory. When spawning a shell for a reverse connection, use purpose "reverse-shell".${wordlistSection}
</environment>

${burpSection}<guidelines>
- Start with reconnaissance unless the user provides recon data.
- Save tool output to files for later reference (use -oN, -o, > redirection, etc.).
- For long-running scans, use appropriate timeouts and scope limitations.
- When using msfconsole, construct single-line commands: msfconsole -q -x "use ...; set RHOSTS ...; run; exit"
- For reverse shells and payloads, pick high port numbers (10000-12000) for LPORT.
- For ANY Python code, ALWAYS use run_python_script — never run Python via run_bash (no "python3 -c", "python3 script.py", or "python3 << EOF" through run_bash). run_python_script accepts the full script in its "script" parameter and an optional "file_name" to persist it. Use descriptive filenames for scripts you want to keep.
- To install a missing tool, call run_install_tool with the tool name — do NOT construct install commands yourself.
- Destructive system commands (rm -rf /, disk wipes, shutdowns) are blocked and require explicit user approval regardless of auto-run settings.
</guidelines>

${webAppSection}
<state_management>
You have a structured engagement state that persists across context summarizations. Use the update_engagement_state tool to record findings as you discover them. This ensures no information is lost when conversation history is compressed.

Record these findings immediately when discovered:
- Hosts, services, and open ports
- Credentials, tokens, and secrets
- Vulnerabilities with severity and evidence
- Files created, downloaded, or analyzed
- Approaches attempted and their outcomes

For every vulnerability, call update_engagement_state with action="add_vulnerability" and provide a report-ready record: title, affected host/target and service/endpoint, severity, CVSS score/vector when supportable, CWE, concise description, concrete evidence, ordered stepsToReproduce, a self-contained contextSummary, impact, remediation, exploited status, and CVE when applicable. Do not invent unknown values; omit them or state the uncertainty in the context summary.

The structured state is injected into your context automatically — do not duplicate it in prose. Focus your messages on reasoning, analysis, and next-step planning.
</state_management>`;
}
