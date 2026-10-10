const PRIVILEGED_PACKAGE_COMMAND =
  /(?:^|(?:&&|\|\||;)\s*)(?:DEBIAN_FRONTEND=\S+\s+)?(?:apt|apt-get|dnf|yum|pacman|zypper)\s+/;

const PIP_COMMAND = /(?:^|(?:&&|\|\||;)\s*)(?:python3?\s+-m\s+)?pip\s+install\b/;

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Registry install commands are trusted server-side values. Package managers
 * still need elevation when the configured exploit-box SSH user is non-root.
 * Prefer passwordless sudo so credentials never enter a command or log.
 */
export function buildPrivilegeAwareInstallCommand(
  installCommand: string,
  isDarwin: boolean,
): string {
  let command = installCommand.trim();
  if (!command || isDarwin) {
    return command;
  }

  if (PIP_COMMAND.test(command)) {
    // Debian/Kali's system Python is PEP 668 externally-managed, so a bare
    // `pip install` is refused. Appending the override keeps registry pip
    // commands working on the stock Kali image. --ignore-installed is needed
    // too: pip otherwise tries to uninstall co-installed Kali system packages
    // (e.g. pyperclip) that carry no RECORD file, aborting the whole install.
    return command.replace(
      /(pip\s+install\b)/,
      "$1 --break-system-packages --ignore-installed",
    );
  }

  if (!PRIVILEGED_PACKAGE_COMMAND.test(command)) {
    return command;
  }

  const stablePackageCommand = command.replace(
    /(^|(?:&&|\|\||;)\s*)apt(?=\s)/g,
    "$1apt-get",
  );
  // Debian/Kali images ship with /var/lib/apt/lists cleaned, so any apt install
  // fails with "has no installation candidate" until the lists are refreshed.
  // Refresh first (cheap when lists are already populated).
  const withUpdate = `apt-get update -qq; ${stablePackageCommand}`;
  const quotedCommand = quoteForShell(
    `export DEBIAN_FRONTEND=noninteractive; ${withUpdate}`,
  );
  return [
    'if [ "$(id -u)" -eq 0 ]; then',
    `  sh -lc ${quotedCommand};`,
    "elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then",
    `  sudo -n sh -lc ${quotedCommand};`,
    "else",
    '  echo "Installation requires root access. Configure passwordless sudo for the exploit-box user or install the package manually." >&2;',
    "  exit 126;",
    "fi",
  ].join(" ");
}
