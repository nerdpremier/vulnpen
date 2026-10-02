import { ExecutionContext, SafetyDetail } from "../tools/types";
import { isDangerousCommand, isDangerousShellInput } from "./commandSafety";
import {
  detectDestructiveBrowserGoal,
  detectDestructiveTargetAction,
} from "./targetSafety";
import {
  checkScope,
  declaredScopeHosts,
  extractCommandHosts,
  isHostInScope,
  isPublicInternetHost,
  parseScopeHosts,
} from "./scopeGate";

export type { SafetyDetail } from "../tools/types";

const OUT_OF_SCOPE_IMPACT =
  "ระบบหรือข้อมูลที่ไม่อยู่ในขอบเขตการทดสอบอาจถูกเข้าถึงโดยไม่ได้รับอนุญาต";

/**
 * Every destructive-target verdict carries the engagement rule with it, so the
 * dialog tells the operator (and the agent reading the result) what to do
 * instead of just that something was stopped.
 */
const POC_NOTE =
  "งานนี้เป็นแบบพิสูจน์แนวคิด (PoC): ใช้หลักฐานที่ไม่ทำลายข้อมูล ไม่ลงมือลบจริง";

/** Allowlist built from the engagement scope text and discovered hosts. */
export function scopeAllowlistFromContext(ctx: ExecutionContext): string[] {
  const state = ctx.engagementState;
  // Fail-open: only the declared Target arms the boundary. The Scope field is
  // prose - if it could arm the gate on its own, a domain mentioned there as an
  // example would silently define the boundary and flag the real target.
  if (!declaredScopeHosts(undefined, state?.declaredTarget).length) return [];
  const hosts = (state?.hosts ?? [])
    .map((h) => [h.hostname, h.ip].filter(Boolean).join(" "))
    .join(" ");
  return parseScopeHosts(state?.scope, hosts);
}

// Tools that only read: what OSINT and ordinary discovery are built from.
const READ_TOOL_RE =
  /\b(curl|wget|http|dig|host|nslookup|whois|ping|traceroute|openssl)\b/i;
// Tools that actively probe or attack a host.
const ATTACK_TOOL_RE =
  /\b(nmap|masscan|nikto|nuclei|sqlmap|ffuf|gobuster|dirb|feroxbuster|wfuzz|hydra|medusa|john|hashcat|msfconsole|msfvenom|wpscan|whatweb|amass|dnsrecon|dnsenum|enum4linux|smbclient|smbmap|crackmapexec|netexec|nxc|impacket|responder|aircrack|reaver|xsser|commix|joomscan|droopescan|sslscan|testssl|fierce|dnsx|katana|waybackurls)\b/i;
// A request that changes state on the other end is not a read.
const WRITE_REQUEST_RE =
  /(?:^|\s)(?:-X|--request)\s*["']?(?:POST|PUT|PATCH|DELETE)|(?:^|\s)-{1,2}(?:data|data-raw|data-binary|data-urlencode|form|upload-file|json)\b|(?:^|\s)-T\s/i;

/**
 * Reading a public page is reconnaissance, not engagement activity: fetching a
 * certificate log, a search engine or a public API does not need approval.
 * Anything that probes a host, or writes to it, is testing and stays bound by
 * the declared engagement.
 */
function isPublicReadOnlyRecon(text: string): boolean {
  if (ATTACK_TOOL_RE.test(text)) return false;
  if (WRITE_REQUEST_RE.test(text)) return false;
  return READ_TOOL_RE.test(text);
}

/**
 * Hosts a command reaches that genuinely leave the engagement: everything the
 * deterministic gate flagged, minus public read-only reconnaissance.
 */
function crossingHosts(text: string, ctx: ExecutionContext): string[] {
  const outside = checkScope(text, scopeAllowlistFromContext(ctx)).outside;
  if (!outside.length) return [];
  if (!isPublicReadOnlyRecon(text)) return outside;
  return outside.filter((host) => !isPublicInternetHost(host));
}

/**
 * Destructive action against the target of the engagement. Separate from the
 * attack-box rules in commandSafety.ts: deleting a record on the client's system
 * is a different (and much more serious) mistake than wiping the tester's box.
 * Returns undefined when the text is only a read or a bounded create.
 */
function destructiveTargetDetail(text: string): SafetyDetail | undefined {
  const hit = detectDestructiveTargetAction(text);
  if (!hit.dangerous) return undefined;
  return {
    kind: "destructive_target",
    reason: hit.reason,
    impact: `${hit.impact} — ${POC_NOTE}`,
  };
}

/** Combined deterministic boundary for a shell command: attack-box destructive
 *  patterns first, then destructive target actions, then the out-of-scope
 *  target check. */
export function shellSafetyDetail(
  text: string,
  ctx: ExecutionContext,
): SafetyDetail | undefined {
  const danger = isDangerousCommand(text);
  if (danger.dangerous) {
    return { kind: "dangerous", reason: danger.reason, impact: danger.impact };
  }
  const target = destructiveTargetDetail(text);
  if (target) return target;
  const crossing = crossingHosts(text, ctx);
  if (crossing.length) {
    return {
      kind: "out_of_scope",
      reason: `คำสั่งเชื่อมต่อไปยัง ${crossing.join(", ")} ซึ่งอยู่นอกขอบเขตการทดสอบที่กำหนดไว้`,
      impact: OUT_OF_SCOPE_IMPACT,
    };
  }
  return undefined;
}

/** Same boundary for shell input typed into a shell on the attack box. */
export function shellInputSafetyDetail(
  text: string,
  ctx: ExecutionContext,
): SafetyDetail | undefined {
  const danger = isDangerousShellInput(text);
  if (danger.dangerous) {
    return { kind: "dangerous", reason: danger.reason, impact: danger.impact };
  }
  const target = destructiveTargetDetail(text);
  if (target) return target;
  const crossing = crossingHosts(text, ctx);
  if (crossing.length) {
    return {
      kind: "out_of_scope",
      reason: `ข้อความที่จะส่งเข้าเชลล์อ้างถึง ${crossing.join(", ")} ซึ่งอยู่นอกขอบเขตการทดสอบที่กำหนดไว้`,
      impact: OUT_OF_SCOPE_IMPACT,
    };
  }
  return undefined;
}

/**
 * Same boundary for shell input into a shell that lives on the target (a reverse
 * shell, a caught bind listener, a session on the compromised host). The never
 * touch the target's data rule applies here more than anywhere: an agent that
 * was exempted from every check just because it had a shell was free to wipe the
 * client's machine. The attack-box wording does not apply, so the verdict is
 * reported as a destructive target action instead.
 */
export function remoteShellInputSafetyDetail(
  text: string,
  ctx: ExecutionContext,
): SafetyDetail | undefined {
  const danger = isDangerousShellInput(text);
  if (danger.dangerous) {
    return {
      kind: "destructive_target",
      reason: `คำสั่งนี้จะรันบนเครื่องเป้าหมายและเข้าข่ายทำลายระบบ (${danger.reason})`,
      impact: `${danger.impact} — ${POC_NOTE}`,
    };
  }
  const target = destructiveTargetDetail(text);
  if (target) return target;
  const crossing = crossingHosts(text, ctx);
  if (crossing.length) {
    return {
      kind: "out_of_scope",
      reason: `คำสั่งบนเครื่องเป้าหมายอ้างถึง ${crossing.join(", ")} ซึ่งอยู่นอกขอบเขตการทดสอบที่กำหนดไว้`,
      impact: OUT_OF_SCOPE_IMPACT,
    };
  }
  return undefined;
}

/**
 * Boundary for a raw HTTP request handed to Burp (Repeater / Intruder). Both the
 * request text and the host named by the tool are checked: a raw request carries
 * no URL for the shell rules to parse, so the host has to come in as an argument.
 */
export function rawRequestSafetyDetail(
  args: { host?: unknown; raw_request?: unknown },
  ctx: ExecutionContext,
): SafetyDetail | undefined {
  const request = typeof args.raw_request === "string" ? args.raw_request : "";
  const destructive = destructiveTargetDetail(request);
  if (destructive) return destructive;

  const allowlist = scopeAllowlistFromContext(ctx);
  if (!allowlist.length) return undefined;
  const host = typeof args.host === "string" ? args.host : "";
  const hosts = [host, ...extractCommandHosts(request)].filter(Boolean);
  const outside = hosts.filter((entry) => !isHostInScope(entry, allowlist));
  if (outside.length) {
    return {
      kind: "out_of_scope",
      reason: `คำขอจะถูกส่งไปยัง ${outside.join(", ")} ซึ่งอยู่นอกขอบเขตการทดสอบที่กำหนดไว้`,
      impact: OUT_OF_SCOPE_IMPACT,
    };
  }
  return undefined;
}

/**
 * Boundary for the browser agent. Its goal is natural language, so the check is
 * on the intent it names plus the host it opens, not on a command string.
 */
export function browserActionSafetyDetail(
  args: { url?: unknown; goal?: unknown },
  ctx: ExecutionContext,
): SafetyDetail | undefined {
  const goal = typeof args.goal === "string" ? args.goal : "";
  const intent = detectDestructiveBrowserGoal(goal);
  if (intent.dangerous) {
    return {
      kind: "destructive_target",
      reason: intent.reason,
      impact: `${intent.impact} — ${POC_NOTE}`,
    };
  }

  const allowlist = scopeAllowlistFromContext(ctx);
  if (!allowlist.length) return undefined;
  const url = typeof args.url === "string" ? args.url : "";
  const outside = extractCommandHosts(url).filter((entry) => !isHostInScope(entry, allowlist));
  if (outside.length) {
    return {
      kind: "out_of_scope",
      reason: `บราวเซอร์จะเปิด ${outside.join(", ")} ซึ่งอยู่นอกขอบเขตการทดสอบที่กำหนดไว้`,
      impact: OUT_OF_SCOPE_IMPACT,
    };
  }
  return undefined;
}