export const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "~/pentest-workspace";

export interface DangerCheckResult {
  dangerous: boolean;
  /** Stable rule id, for tests and consent statistics. */
  rule: string;
  /** Short Thai reason shown in the consent dialog. */
  reason: string;
  /** Short Thai impact statement shown in the consent dialog. */
  impact: string;
}

const SAFE_RESULT: DangerCheckResult = { dangerous: false, rule: "", reason: "", impact: "" };

function danger(rule: string, reason: string, impact: string): DangerCheckResult {
  return { dangerous: true, rule, reason, impact };
}

/**
 * Filesystem roots whose deletion or blanket permission change destroys the
 * attack box. /tmp is deliberately excluded — scratch caches live there.
 */
const SENSITIVE_ROOTS = [
  "/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/media",
  "/mnt", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys",
  "/usr", "/var",
];

const HOME_TOKENS = ["~", "$HOME", "${HOME}", "/root", "/home"];

const BLOCK_DEVICE = /^\/dev\/(sd[a-z]+|hd[a-z]+|nvme\d+n\d+(p\d+)?|vd[a-z]+|mmcblk\d+(p\d+)?|loop\d+)$/;

interface SegmentFlags {
  recursive: boolean;
  force: boolean;
  noPreserveRoot: boolean;
}

function normalizeLongFlags(text: string): string {
  return text
    .replace(/(^|\s)--recursive(?=\s|$)/g, "$1-r")
    .replace(/(^|\s)--force(?=\s|$)/g, "$1-f");
}

/** Split a shell input into command segments on unquoted ;, |, &&, ||, newlines. */
export function splitShellSegments(input: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n" || ch === "&") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/** Quote-aware token split of one command segment. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of segment) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function isBareGlob(token: string): boolean {
  return token === "*" || token === "./" || token === "." || token === ".." || token === "./*";
}

function isSensitivePath(token: string): boolean {
  if (token === "/") return true;
  const t = token.replace(/\/+$/, "");
  if (isBareGlob(t)) return true;
  if (HOME_TOKENS.includes(t)) return true;
  if (SENSITIVE_ROOTS.includes(t)) return true;
  // Subtrees of system roots count as system-critical too (/etc/config, /var/log).
  if (SENSITIVE_ROOTS.some((root) => root !== "/" && t.startsWith(root + "/"))) return true;
  return false;
}

function isExactRootPath(token: string): boolean {
  if (token === "/") return true;
  const t = token.replace(/\/+$/, "");
  return SENSITIVE_ROOTS.includes(t) || HOME_TOKENS.includes(t);
}

function flagsOf(tokens: string[]): SegmentFlags {
  const f: SegmentFlags = { recursive: false, force: false, noPreserveRoot: false };
  for (const t of tokens) {
    if (t === "--no-preserve-root") f.noPreserveRoot = true;
    if (!t.startsWith("-") || t.startsWith("--")) continue;
    if (t.includes("r") || t.includes("R")) f.recursive = true;
    if (t.includes("f")) f.force = true;
  }
  return f;
}

/** Destructive decode-to-shell chains: base64 -d | sh, curl url | bash, xxd -r | sh. */
function decodeToShell(segment: string): boolean {
  const stages = segment.split("|").map((s) => s.trim());
  if (stages.length < 2) return false;
  const decoder = /(^|\s)(base64\s+(-[^-\s]*d|--decode)|xxd\s+-r|openssl\s+enc\s+[^|]*-d|gunzip|zcat)\b/i;
  const fetcher = /^(curl|wget|fetch)\b/i;
  const shell = /^(sh|bash|zsh|dash|ksh|python3?|perl)\b/i;
  let decodes = false;
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    if (decoder.test(s) || (fetcher.test(s) && i === 0)) decodes = true;
    else if (/^(curl|wget|fetch)\b/.test(s)) {
      // a fetch stage that is not first (e.g. re-download mid-pipe) still counts
      decodes = true;
    }
    if (decodes && shell.test(s)) return true;
  }
  return false;
}

function checkSegment(raw: string): DangerCheckResult {
  const segment = normalizeLongFlags(raw);
  const tokens = tokenize(segment);
  const cmd = tokens[0];

  if (cmd === "rm") {
    const f = flagsOf(tokens);
    const operands = tokens.slice(1).filter((t) => !t.startsWith("-") && t !== "--");
    if (f.noPreserveRoot) {
      return danger(
        "rm:no-preserve-root",
        "rm ปิดกันการลบรากไฟล์ซิสเทม (--no-preserve-root)",
        "ลบไฟล์ระบบทั้งเครื่อง ทำให้เครื่องทดสอบใช้งานไม่ได้",
      );
    }
    if (f.recursive && operands.some((t) => isSensitivePath(t) || isBareGlob(t))) {
      return danger(
        f.force ? "rm:recursive-force" : "rm:recursive",
        "rm ลบแบบวนซ้ำบนพาธระบบหรือทั้งโฟลเดอร์ปัจจุบัน",
        f.force
          ? "ลบไฟล์และโฟลเดอร์ถาวรโดยไม่ถามยืนยัน กู้คืนกลับไม่ได้"
          : "ลบไฟล์และโฟลเดอร์ถาวร กู้คืนกลับไม่ได้",
      );
    }
  }

  if (["dd", "truncate", "shred", "blkdiscard", "mkfs", "mke2fs", "mkswap", "newfs"].some((c) => cmd?.startsWith(c))) {
    const ofIdx = tokens.findIndex((t) => t.startsWith("of="));
    const ofValue = ofIdx >= 0 ? tokens[ofIdx].slice(3) : "";
    const deviceOperand = tokens.slice(1).find((t) => BLOCK_DEVICE.test(t.replace(/["']/g, "")));
    if (
      cmd === "dd" &&
      (BLOCK_DEVICE.test(ofValue.replace(/["']/g, "")) || ofValue.startsWith("/dev/"))
    ) {
      return danger("dd:block-device", "dd เขียนข้อมูลทับอุปกรณ์จัดเก็บโดยตรง", "ข้อมูลเดิมบนดิสก์ถูกเขียนทับถาวร");
    }
    if (cmd?.startsWith("mkfs") || cmd === "mke2fs" || cmd === "newfs" || cmd === "mkswap") {
      return danger("mkfs:format", "จัดฟอร์แมตไฟล์ซิสเทม", "ข้อมูลทั้งหมดบนพาร์ติชันเป้าหมายหายถาวร");
    }
    if ((cmd === "truncate" || cmd === "shred" || cmd === "blkdiscard") && deviceOperand) {
      return danger("truncate:block-device", "เขียนทับหรือลบข้อมูลบนอุปกรณ์จัดเก็บโดยตรง", "ข้อมูลบนดิสก์หายถาวร");
    }
  }

  // Redirect to a block device: > /dev/sda, >| /dev/nvme0n1, 2>/dev/sda
  const redirectIdx = tokens.findIndex((t) => /^[>]{1,2}\|?$/.test(t));
  const redirectTarget = redirectIdx >= 0 ? tokens[redirectIdx + 1] : undefined;
  if (
    (redirectTarget && BLOCK_DEVICE.test(redirectTarget)) ||
    /(?:^|\s)\d?>{1,2}\|?\s*\/dev\/(sd|hd|nvme|vd|mmcblk|loop\d)/.test(raw)
  ) {
    return danger("redirect:block-device", "เขียนข้อมูลทับดิสก์โดยตรงผ่าน redirect", "ข้อมูลบนดิสก์หายถาวร");
  }

  if (cmd === "chmod" || cmd === "chown") {
    const f = flagsOf(tokens);
    const operands = tokens.slice(1).filter((t) => !t.startsWith("-"));
    // Last operand is the path; mode/user come before it.
    const path = operands[operands.length - 1];
    const mode = operands.slice(0, -1).join(" ");
    if (f.recursive && path && (isSensitivePath(path) || mode.includes("777") || mode.includes("000"))) {
      return danger(
        cmd === "chmod" ? "chmod:recursive" : "chown:recursive",
        cmd === "chmod"
          ? "chmod เปลี่ยนสิทธิ์แบบวนซ้ำบนพาธระบบ"
          : "chown เปลี่ยนเจ้าของแบบวนซ้ำบนพาธระบบ",
        "สิทธิ์ของไฟล์ระบบเปลี่ยนทั้งชุด อาจทำให้เครื่องทดสอบเสียหาย",
      );
    }
  }

  if (cmd === "find" && /\s-delete(\s|$)/.test(raw) && tokens.slice(1).some((t) => isSensitivePath(t))) {
    return danger("find:delete", "find ลบไฟล์แบบวนซ้ำบนพาธระบบ", "ไฟล์ระบบถูกลบถาวรโดยไม่ถามยืนยัน");
  }

  if (["shutdown", "poweroff", "halt", "reboot"].includes(cmd ?? "") || (cmd === "init" && ["0", "6"].includes(tokens[1]))) {
    return danger("power:shutdown", "ปิดหรือรีสตาร์ตเครื่องทดสอบ", "การทดสอบทั้งหมดที่กำลังทำงานหยุดทันที");
  }

  if (cmd === "systemctl" && ["poweroff", "reboot", "halt"].includes(tokens[1] ?? "")) {
    return danger("power:systemctl", "ปิดหรือรีสตาร์ตเครื่องทดสอบผ่าน systemctl", "การทดสอบทั้งหมดที่กำลังทำงานหยุดทันที");
  }

  if (cmd === "mv") {
    const operands = tokens.slice(1).filter((t) => !t.startsWith("-"));
    if (operands.some((t) => t === "/*" || isExactRootPath(t))) {
      return danger("mv:root", "mv ย้ายเนื้อหาระดับรากของไฟล์ซิสเทม", "ไฟล์ระบบหลุดจากตำแหน่งเดิม เครื่องเสียหาย");
    }
  }

  return SAFE_RESULT;
}

/**
 * Whole-input rules that reason about pipe/ampersand structure. They must run
 * before segment splitting, which strips | and & and would hide them.
 */
function checkRawStructure(raw: string): DangerCheckResult {
  if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:?/.test(raw)) {
    return danger("fork:bomb", "สร้างกระบวนการคัดลอกตัวเองไม่สิ้นสุด (fork bomb)", "หน่วยความจำและ CPU เต็ม เครื่องทดสอบหยุดทำงาน");
  }
  if (/while\s+(true|:)\b/.test(raw) && raw.includes("&") && !raw.includes("sleep")) {
    return danger("fork:loop", "วนลูปไม่รู้จบแบบเบิ้ลกระบวนการ", "CPU ถูกใช้จนหมด งานอื่นบนเครื่องค้าง");
  }
  if (decodeToShell(raw)) {
    return danger(
      "pipe:decode-shell",
      "ดึงหรือถอดรหัสสคริปต์จากภายนอกแล้วป้อนให้เชลล์รันทันที",
      "โค้ดจากแหล่งภายนอกทำงานด้วยสิทธิ์ของเครื่องทดสอบ ควบคุมพฤติกรรมไม่ได้",
    );
  }
  return SAFE_RESULT;
}

export function isDangerousCommand(command: string): DangerCheckResult {
  if (!command || typeof command !== "string") return SAFE_RESULT;
  const rawResult = checkRawStructure(normalizeLongFlags(command));
  if (rawResult.dangerous) return rawResult;
  for (const segment of splitShellSegments(command)) {
    const result = checkSegment(segment);
    if (result.dangerous) return result;
  }
  return SAFE_RESULT;
}

export function isDangerousShellInput(input: string): DangerCheckResult {
  if (!input || typeof input !== "string") return SAFE_RESULT;
  const lines = input.split("\n").map((l) => l.replace(/\\n/g, "").trim()).filter(Boolean);
  for (const line of lines) {
    const result = isDangerousCommand(line);
    if (result.dangerous) return result;
  }
  return SAFE_RESULT;
}
