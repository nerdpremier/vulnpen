import { DangerCheckResult, isDangerousShellInput } from "./commandSafety";

const SAFE_RESULT: DangerCheckResult = { dangerous: false, rule: "", reason: "", impact: "" };

function danger(rule: string, reason: string, impact: string): DangerCheckResult {
  return { dangerous: true, rule, reason, impact };
}

/** Pull double-, single- and triple-quoted string literals out of Python source. */
function extractLiterals(source: string): string[] {
  const literals: string[] = [];
  const re = /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g;
  for (const match of source.matchAll(re)) {
    const raw = match[0];
    if (raw.startsWith('"""') || raw.startsWith("'''")) literals.push(raw.slice(3, -3));
    else literals.push(raw.slice(1, -1));
  }
  return literals;
}

/** Filesystem roots whose removal takes the attack box with them. */
const SENSITIVE_PATHS = new Set([
  "", "/", "~", "$HOME", "/root", "/home", "/etc", "/usr", "/var",
  "/bin", "/boot", "/lib", "/lib64", "/sbin", "/srv", "/opt", "/sys", "/proc", "/dev",
]);

/** A literal that names a system root or something inside one. */
function literalHitsSystemRoot(value: string): boolean {
  const t = value.replace(/\/+$/, "");
  if (SENSITIVE_PATHS.has(t)) return true;
  return [...SENSITIVE_PATHS].some((root) => root.length > 1 && t.startsWith(root + "/"));
}

/**
 * Calls that hand a command list to the OS. The list form is the one the shell
 * rules cannot see: `subprocess.run(["rm", "-rf", "/"])` carries the command
 * across three separate literals, so the items are rejoined into one line and
 * checked as a shell command.
 */
const COMMAND_LIST_CALL_RE =
  /\b(?:subprocess\.(?:run|call|check_call|check_output|Popen)|os\.(?:system|popen|execv|execve|execvp|execvpe|spawnv|spawnve|spawnvp|spawnvpe|posix_spawn|posix_spawnp))\s*\(\s*\[([^\]]*)\]/g;

/** Filesystem primitives that remove, truncate or overwrite a path. */
const DESTRUCTIVE_FS_CALL_RE =
  /\b(?:os\.(?:remove|unlink|rmdir|removedirs|truncate)|shutil\.rmtree|shutil\.move|pathlib\.Path\s*\([^)]*\)\.unlink)\s*\(([^)]*)\)/g;

/** open(path, "w") — a mode that replaces the file's contents. */
const OPEN_FOR_WRITE_RE = /\bopen\s*\(\s*([^,)]+)\s*,\s*["'][wax]b?["']/g;

/**
 * Static safety gate for agent-supplied Python scripts. The script runs with
 * full privileges of the attack box, so shell-out helpers and destructive
 * filesystem primitives must pass the same boundary as run_bash.
 */
export function isDangerousPythonScript(source: string): DangerCheckResult {
  if (!source || typeof source !== "string") return SAFE_RESULT;

  // Shell-out helpers: any embedded shell string crosses the same boundary.
  for (const literal of extractLiterals(source)) {
    const shellResult = isDangerousShellInput(literal);
    if (shellResult.dangerous) {
      return danger(
        `python:${shellResult.rule}`,
        `สคริปต์ Python เรียกคำสั่งเชลล์ที่อันตราย (${shellResult.reason})`,
        shellResult.impact,
      );
    }
  }

  // Command lists: ["rm", "-rf", "/"] is the same command as `rm -rf /`.
  for (const match of source.matchAll(COMMAND_LIST_CALL_RE)) {
    const joined = extractLiterals(match[1]).join(" ");
    if (!joined) continue;
    const shellResult = isDangerousShellInput(joined);
    if (shellResult.dangerous) {
      return danger(
        `python:${shellResult.rule}`,
        `สคริปต์ Python รันคำสั่งที่อันตรายผ่านรายการอาร์กิวเมนต์ (${shellResult.reason})`,
        shellResult.impact,
      );
    }
  }

  if (/while\s+True\s*:/.test(source) && /\bos\.fork\s*\(/.test(source)) {
    return danger(
      "python:fork-loop",
      "สคริปต์สร้างกระบวนการไม่สิ้นสุดด้วย os.fork ในลูป",
      "หน่วยความจำและ CPU เต็ม เครื่องทดสอบหยุดทำงาน",
    );
  }

  // Removal, truncation and overwrite of a system path.
  for (const match of source.matchAll(DESTRUCTIVE_FS_CALL_RE)) {
    if (extractLiterals(match[1]).some(literalHitsSystemRoot)) {
      return danger(
        "python:remove-system-path",
        "สคริปต์ลบ ตัดทอน หรือเขียนทับพาธระบบ",
        "ไฟล์ระบบถูกลบหรือเขียนทับถาวรโดยไม่ถามยืนยัน",
      );
    }
  }

  for (const match of source.matchAll(OPEN_FOR_WRITE_RE)) {
    if (extractLiterals(match[1]).some(literalHitsSystemRoot)) {
      return danger(
        "python:overwrite-system-file",
        "สคริปต์เปิดไฟล์ระบบเพื่อเขียนทับ",
        "ไฟล์ระบบถูกเขียนทับถาวร เครื่องทดสอบอาจใช้งานไม่ได้",
      );
    }
  }

  if (/open\s*\(\s*f?["']\/dev\/(sd|hd|nvme|vd|mmcblk)[^"']*["']\s*,\s*["'][wa+]?b?["']/.test(source)) {
    return danger(
      "python:block-device",
      "สคริปต์เขียนข้อมูลทับดิสก์โดยตรง",
      "ข้อมูลบนดิสก์หายถาวร",
    );
  }

  if (/\bos\.chmod\s*\(\s*f?["'](\/etc|\/usr|\/var|\/bin|\/boot|\/root|\/home)["']/.test(source) && /0o?777|0o?000/.test(source)) {
    return danger(
      "python:chmod",
      "สคริปต์เปลี่ยนสิทธิ์พาธระบบเป็นแบบเปิดกว้าง",
      "สิทธิ์ของไฟล์ระบบเปลี่ยนทั้งชุด อาจทำให้เครื่องทดสอบเสียหาย",
    );
  }

  return SAFE_RESULT;
}
