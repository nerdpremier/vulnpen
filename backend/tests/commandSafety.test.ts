import assert from "node:assert/strict";
import test from "node:test";
import { isDangerousCommand } from "../src/utils/commandSafety";

test("recursive root deletion with long options crosses the safety boundary", () => {
  const result = isDangerousCommand("rm --recursive --force /");
  assert.equal(result.dangerous, true);
  assert.match(result.reason, /system-critical paths/);
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

test("offensive attack-box commands remain automatic", () => {
  for (const command of [
    "nmap -sV target",
    "sqlmap -u https://target",
    "msfconsole -q -x exploit",
    "python3 exploit.py",
    "bash -c id",
    "nc -lvnp 4444",
    "curl https://target/payload | sh",
    "rm -rf ./loot",
    "rm -rf /tmp/tool-cache",
  ]) {
    assert.equal(isDangerousCommand(command).dangerous, false, command);
  }
});
