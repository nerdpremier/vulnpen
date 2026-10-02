import { DangerCheckResult, isDangerousShellInput } from "./commandSafety";

const SAFE_RESULT: DangerCheckResult = { dangerous: false, rule: "", reason: "", impact: "" };

function danger(rule: string, reason: string, impact: string): DangerCheckResult {
  return { dangerous: true, rule, reason, impact };
}

/** Pull double- and single-quoted string literals out of Python source. */
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

  if (/while\s+True\s*:/.test(source) && /\bos\.fork\s*\(/.test(source)) {
    return danger(
      "python:fork-loop",
      "สคริปต์สร้างกระบวนการไม่สิ้นสุดด้วย os.fork ในลูป",
      "หน่วยความจำและ CPU เต็ม เครื่องทดสอบหยุดทำงาน",
    );
  }

  const rmtreeTargets = [...source.matchAll(/shutil\.rmtree\s*\(\s*(f?["']([^"']*)["'])/g)].map((m) => m[2]);
  for (const target of rmtreeTargets) {
    const t = target.replace(/\/+$/, "");
    if (
      t === "" ||
      t === "/" ||
      ["~", "$HOME", "/root", "/home", "/etc", "/usr", "/var", "/bin", "/boot", "/lib", "/sbin", "/srv", "/opt"].includes(t)
    ) {
      return danger(
        "python:rmtree",
        "สคริปต์ลบโฟลเดอร์ระบบแบบวนซ้ำ (shutil.rmtree)",
        "ไฟล์ระบบถูกลบถาวรโดยไม่ถามยืนยัน",
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
