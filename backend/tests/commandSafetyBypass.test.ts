import assert from "node:assert/strict";
import test from "node:test";
import { isDangerousCommand, isDangerousShellInput } from "../src/utils/commandSafety";

/**
 * Bypass / evasion coverage for the attack-box command rules.
 *
 * The rule set reads a command by its head token, so the whole game is getting
 * the *real* command to be the head. Each group below is one way of hiding it:
 * a privilege or wrapper prefix, a nested shell, an eval, a command
 * substitution, an interpreter payload, or a spelling of the destructive
 * primitive that the original rules did not look for.
 *
 * A miss here is not cosmetic: these rules are the boundary applied to a shell
 * on the engagement target, where the same command destroys the client's
 * machine rather than a disposable one.
 */

test("wrapper prefixes cannot hide the destructive command", () => {
  for (const command of [
    "sudo rm -rf /",
    "sudo -u root rm -rf /etc",
    "doas rm -rf /",
    "env rm -rf /",
    "env VAR=1 rm -rf /etc",
    "env -i bash -c 'rm -rf /'",
    "nohup rm -rf /",
    "setsid rm -rf /",
    "nice -n 5 rm -rf /",
    "command rm -rf /",
    "exec rm -rf /",
    "timeout 5 rm -rf /",
    "timeout -s KILL 5 rm -rf /etc",
    "sudo timeout 5 rm -rf /etc",
    "chroot /mnt rm -rf /",
    "su -c 'rm -rf /' root",
    "su root -c 'rm -rf /'",
    "sudo dd if=/dev/zero of=/dev/sda",
  ]) {
    assert.equal(isDangerousCommand(command).dangerous, true, command);
  }
});

test("a nested shell, eval or interpreter payload is the same command", () => {
  for (const command of [
    "bash -c 'rm -rf /'",
    'sh -c "dd if=/dev/zero of=/dev/sda"',
    "sudo bash -c 'rm -rf /'",
    "bash -c 'sudo rm -rf /'",
    'eval "rm -rf /"',
    "su -c 'rm -rf /' root",
    "sh -c 'echo x > /etc/passwd'",
    `python3 -c "import os; os.system('rm -rf /')"`,
    `perl -e 'system("rm -rf /")'`,
    `node -e "require('child_process').execSync('rm -rf /')"`,
  ]) {
    assert.equal(isDangerousCommand(command).dangerous, true, command);
  }
});

test("command substitution is a command, not text", () => {
  for (const command of [
    "echo $(rm -rf /etc)",
    "echo `rm -rf /`",
    'echo "$(bash -c \'rm -rf /\')"',
    "cat /tmp/x $(dd if=/dev/zero of=/dev/sda)",
  ]) {
    assert.equal(isDangerousCommand(command).dangerous, true, command);
  }
});

test("destructive primitives the original rules did not look for", () => {
  for (const command of [
    "echo x > /etc/passwd",
    "rm -f /etc/passwd",
    "cd /etc && sudo rm -rf *",
  ]) {
    assert.equal(isDangerousCommand(command).dangerous, true, command);
  }
});

test("the evasion table does not turn ordinary testing into a prompt", () => {
  // A detector that flags these is worse than useless: the operator learns to
  // approve without reading, and the boundary stops meaning anything.
  for (const command of [
    "nmap -sV target",
    "sqlmap -u https://target --batch",
    "python3 exploit.py",
    "bash -c id",
    "rm -rf ./loot",
    "rm -rf /tmp/tool-cache",
    "rm loot.txt",
    "chmod +x exploit.sh",
    "curl https://target/api -d @payload.json",
    "find /tmp -name '*.tmp' -delete",
    "echo hello | bash -c 'cat'",
    "echo 'rm -rf /'",
    "echo rm -rf /",
    "grep -r rm /tmp/x",
    "ls -la /etc",
    "cat /etc/hosts",
    "cmd 2>/dev/null",
    "nmap -sV target 2>/dev/null",
    "rm -rf /tmp/x 2>/dev/null",
    "echo done > /tmp/out.txt",
    "echo x >> /tmp/log.txt",
    `python3 -c "print(1)"`,
    `python3 -c "print('rm -rf /')"`,
    "timeout 5 nmap -sV target",
    "sudo nmap -sV target",
    "sudo -u root nmap target",
    "env -i curl http://target/",
  ]) {
    assert.equal(isDangerousCommand(command).dangerous, false, command);
  }
});

test("evasion is caught per line in multi-line shell input", () => {
  assert.equal(
    isDangerousShellInput("nmap -sV target\nsudo rm -rf /").dangerous,
    true,
  );
  assert.equal(
    isDangerousShellInput("nmap -sV target\nrm -rf ./loot").dangerous,
    false,
  );
});

test("nesting depth is bounded, so a payload cannot stall the check", () => {
  // A chain of wrappers must terminate, and the depth cap must not become a way
  // to get a destructive command past the rules: it is checked at every level.
  const deep = "sudo ".repeat(20) + "rm -rf /";
  assert.equal(isDangerousCommand(deep).dangerous, true);
});
