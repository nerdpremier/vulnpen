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

/** Device nodes that are meant to be written: redirecting into them is routine. */
const SAFE_DEVICE_TARGETS = new Set([
  "/dev/null", "/dev/zero", "/dev/stdout", "/dev/stderr", "/dev/random",
  "/dev/urandom", "/dev/tty", "/dev/full",
]);

/** How deep a wrapper / substitution chain may nest before the check gives up. */
const MAX_UNWRAP_DEPTH = 6;

/**
 * Commands whose only job is to launch another command. The destructive verb is
 * further right, so the rule set has to be applied again from that position —
 * `sudo rm -rf /` is the same mistake as `rm -rf /` and used to pass unseen.
 */
const WRAPPER_COMMANDS = new Set([
  "sudo", "doas", "env", "nohup", "time", "timeout", "nice", "ionice", "stdbuf",
  "setsid", "command", "builtin", "exec", "xargs", "watch", "unbuffer", "script",
  "chroot", "su", "runuser", "busybox", "parallel", "daemonize", "start-stop-daemon",
]);

/**
 * Flags that consume the token after them, per wrapper. It has to be per
 * wrapper: `-i` is "ignore environment" for env (no value) and "login shell"
 * for sudo (no value), while `-n` takes a value for nice and xargs. A single
 * shared set silently swallowed the command after `env -i bash -c …`.
 */
const WRAPPER_VALUE_FLAGS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "--user", "-g", "--group", "-p", "--prompt", "-C", "--chdir", "-U", "--other-user", "-R", "--chroot", "--role", "--type", "--host", "-D"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"]),
  xargs: new Set(["-I", "--replace", "-P", "--max-procs", "-d", "--delimiter", "-a", "--arg-file", "-L", "--max-lines", "-n", "--max-args", "-s", "--max-chars", "-E", "--eof", "-e"]),
  chroot: new Set(["--userspec", "--groups"]),
  su: new Set(["-c", "--command", "-s", "--shell", "-g", "--group", "-G", "--supp-group", "-w", "--whitelist-environment"]),
  runuser: new Set(["-c", "--command", "-s", "--shell", "-g", "--group", "-G", "--supp-group"]),
  script: new Set(["-c", "--command", "-t", "--timing", "-T", "--log-timing", "-O", "--log-out", "-I", "--log-in", "-B", "--log-io", "-E", "--echo"]),
  watch: new Set(["-n", "--interval", "-d", "--differences", "-s", "--shotsdir"]),
  time: new Set(["-o", "--output", "-f", "--format"]),
  command: new Set(["-p"]),
  exec: new Set(["-a"]),
  parallel: new Set(["--jobs", "-j", "--results", "-N", "-n", "-L", "-l", "--sshlogin", "-S", "--delimiter", "-d"]),
  "start-stop-daemon": new Set(["-p", "--pidfile", "-x", "--exec", "-a", "--startas", "-u", "--user", "-c", "--chuid", "-n", "--name", "-R", "--retry"]),
  daemonize: new Set(["-c", "--chdir", "-u", "--user", "-E", "--env", "-p", "--pidfile"]),
  busybox: new Set(),
  nohup: new Set(),
  setsid: new Set(),
  builtin: new Set(),
  stdbuf: new Set(),
  unbuffer: new Set(),
};

function wrapperValueFlags(name: string): Set<string> {
  return WRAPPER_VALUE_FLAGS[name] ?? new Set<string>();
}

/**
 * Wrappers whose first bare operand is an argument rather than the command:
 * `timeout 5 rm …`, `chroot /mnt rm …`, `su www-data rm …`.
 */
const WRAPPER_OPERAND_COUNT: Record<string, number> = {
  timeout: 1,
  chroot: 1,
  su: 1,
  runuser: 1,
  "start-stop-daemon": 0,
  daemonize: 0,
  parallel: 0,
  script: 0,
};

/** Interpreters that take a program on the command line, plus the flag that introduces it. */
const INLINE_CODE_FLAGS: Record<string, string[]> = {
  bash: ["-c"],
  sh: ["-c"],
  zsh: ["-c"],
  dash: ["-c"],
  ksh: ["-c"],
  ash: ["-c"],
  csh: ["-c"],
  tcsh: ["-c"],
  fish: ["-c"],
  python: ["-c"],
  python3: ["-c"],
  perl: ["-e"],
  ruby: ["-e"],
  node: ["-e", "--eval"],
  php: ["-r"],
  lua: ["-e"],
  su: ["-c"],
  runuser: ["-c"],
  script: ["-c"],
};

/** Builtins whose argument is itself the code to run, with no introducing flag. */
const EVAL_COMMANDS = new Set(["eval"]);

/**
 * Calls that hand a string to an interpreter. Only when one is present is it
 * worth reading the code's string literals as commands: `os.system('rm -rf /')`
 * is a command, `print('rm -rf /')` is text.
 */
const SHELL_OUT_CALL_RE =
  /\b(?:os\.system|os\.popen|subprocess\.\w+|commands\.getoutput|popen|system\s*\(|exec\w*\s*\(|spawn\w*\s*\(|child_process|`)/;

/** Double-, single- and triple-quoted literals, with their quotes removed. */
function extractStringLiterals(source: string): string[] {
  const literals: string[] = [];
  const re = /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;
  for (const match of source.matchAll(re)) {
    const raw = match[0];
    literals.push(
      raw.startsWith('"""') || raw.startsWith("'''") ? raw.slice(3, -3) : raw.slice(1, -1),
    );
  }
  return literals;
}

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

/**
 * Where a real command may start in a token list. Index 0 is always a
 * candidate; each wrapper found at the front contributes the position of the
 * command it launches, so `sudo timeout 5 rm -rf /` yields `rm`.
 */
function commandStartIndices(tokens: string[]): number[] {
  const starts = [0];
  let i = 0;
  // Bounded by the token count, not by the recursion depth: `sudo sudo … rm`
  // is still `rm`, and a chain of wrappers must not be a way past the rules.
  while (i < tokens.length && WRAPPER_COMMANDS.has(tokens[i])) {
    const next = skipWrapper(tokens, i);
    if (next <= i || next >= tokens.length) break;
    i = next;
    starts.push(i);
  }
  return starts;
}

/** Position of the command a wrapper at `i` launches. */
function skipWrapper(tokens: string[], i: number): number {
  const valueFlags = wrapperValueFlags(tokens[i]);
  let j = i + 1;
  while (j < tokens.length && tokens[j].startsWith("-") && tokens[j] !== "--") {
    const flag = tokens[j];
    j += 1;
    if (valueFlags.has(flag) && j < tokens.length) j += 1;
  }
  if (j < tokens.length && tokens[j] === "--") j += 1;
  // `env VAR=1 cmd`
  while (j < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[j])) j += 1;
  let operands = WRAPPER_OPERAND_COUNT[tokens[i]] ?? 0;
  while (operands > 0 && j < tokens.length) {
    if (!tokens[j].startsWith("-")) operands -= 1;
    j += 1;
  }
  return j;
}

/**
 * The program an interpreter is asked to run inline: `bash -c '<cmd>'`,
 * `python3 -c '<code>'`, `perl -e '<code>'`. The code is handed back so the
 * rule set can be applied to it — `bash -c 'rm -rf /'` is one command, not two.
 */
function inlineCode(tokens: string[]): string | undefined {
  const head = tokens[0] ?? "";
  if (EVAL_COMMANDS.has(head)) return tokens.slice(1).join(" ");
  const flags = INLINE_CODE_FLAGS[head];
  if (!flags?.length) return undefined;
  const valueFlags = wrapperValueFlags(head);
  for (let i = 1; i < tokens.length; i++) {
    if (flags.includes(tokens[i])) return tokens[i + 1];
    if (tokens[i].startsWith("-") && valueFlags.has(tokens[i])) i += 1;
  }
  return undefined;
}

/**
 * Verdict for code handed to an interpreter. The code is checked as shell, and
 * — only when it contains a call that passes a string to a shell — its string
 * literals are checked too, because `os.system('rm -rf /')` reaches the shell
 * through a quoted argument.
 */
function codeDanger(code: string, depth: number): DangerCheckResult {
  const direct = checkInput(code, depth + 1);
  if (direct.dangerous) return direct;
  if (!SHELL_OUT_CALL_RE.test(code)) return SAFE_RESULT;
  for (const literal of extractStringLiterals(code)) {
    const inner = checkInput(literal, depth + 1);
    if (inner.dangerous) return inner;
  }
  return SAFE_RESULT;
}

/**
 * Bodies of command substitutions (`$(…)`) and backticks — both run, so their
 * contents are commands. Single-quoted text is a literal and is skipped;
 * double-quoted text is not, because `"$(rm -rf /)"` still runs.
 */
function substitutionBodies(text: string): string[] {
  const bodies: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === "'") {
      quote = "'";
      continue;
    }
    if (ch === '"' && quote === null) {
      quote = '"';
      continue;
    }
    if (ch === '"') {
      quote = null;
      continue;
    }
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end < 0) break;
      bodies.push(text.slice(i + 1, end));
      i = end;
      continue;
    }
    if (ch === "$" && text[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === "(") depth += 1;
        else if (text[j] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (j < text.length) {
        bodies.push(text.slice(i + 2, j));
        i = j;
      }
    }
  }
  return bodies;
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

/** The rule set, applied to one token list (a segment, or the tail of one). */
function checkTokens(tokens: string[], raw: string): DangerCheckResult {
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
    // Forced removal of a system file: `rm -f /etc/passwd` needs no -r to hurt.
    if (f.force && operands.some((t) => isSensitivePath(t) && !isBareGlob(t))) {
      return danger(
        "rm:force-system-file",
        "rm บังคับลบไฟล์ระบบโดยไม่ถามยืนยัน",
        "ไฟล์ระบบหายถาวร เครื่องทดสอบอาจใช้งานไม่ได้",
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
  // Redirect over a system file: `echo x > /etc/passwd`. The write targets are
  // the ones meant to be written; a block device is caught above.
  if (
    redirectTarget &&
    isSensitivePath(redirectTarget) &&
    !SAFE_DEVICE_TARGETS.has(redirectTarget) &&
    !redirectTarget.startsWith("/dev/fd/")
  ) {
    return danger(
      "redirect:system-file",
      "เขียนทับไฟล์ระบบผ่าน redirect",
      "ไฟล์ระบบถูกเขียนทับถาวร เครื่องทดสอบอาจใช้งานไม่ได้",
    );
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

function checkSegment(raw: string, depth: number): DangerCheckResult {
  if (depth > MAX_UNWRAP_DEPTH) return SAFE_RESULT;
  const segment = normalizeLongFlags(raw);
  const tokens = tokenize(segment);
  if (!tokens.length) return SAFE_RESULT;

  for (const start of commandStartIndices(tokens)) {
    const rest = tokens.slice(start);
    // `bash -c '<cmd>'` / `python3 -c '<code>'`: the payload is the command.
    const code = inlineCode(rest);
    if (code) {
      const inner = codeDanger(code, depth);
      if (inner.dangerous) return inner;
    }
    const result = checkTokens(rest, segment);
    if (result.dangerous) return result;
  }
  return SAFE_RESULT;
}

/** Every command in one shell input, at any nesting depth. */
function checkInput(input: string, depth: number): DangerCheckResult {
  if (depth > MAX_UNWRAP_DEPTH) return SAFE_RESULT;
  const rawResult = checkRawStructure(normalizeLongFlags(input));
  if (rawResult.dangerous) return rawResult;
  for (const body of substitutionBodies(input)) {
    const inner = checkInput(body, depth + 1);
    if (inner.dangerous) return inner;
  }
  for (const segment of splitShellSegments(input)) {
    const result = checkSegment(segment, depth);
    if (result.dangerous) return result;
  }
  return SAFE_RESULT;
}

export function isDangerousCommand(command: string): DangerCheckResult {
  if (!command || typeof command !== "string") return SAFE_RESULT;
  return checkInput(command, 0);
}

export function isDangerousShellInput(input: string): DangerCheckResult {
  if (!input || typeof input !== "string") return SAFE_RESULT;
  const lines = input.split("\n").map((l) => l.replace(/\\n/g, "").trim()).filter(Boolean);
  for (const line of lines) {
    const result = checkInput(line, 0);
    if (result.dangerous) return result;
  }
  return SAFE_RESULT;
}
