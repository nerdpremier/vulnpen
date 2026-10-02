export interface Capability {
  name: string;
  type: "binary" | "python_package";
  bucket: string;
  label: string;
  description: string;
  usageHint?: string;
  installCommand: string;
  /** macOS (Darwin) install command. Uses brew when not set. */
  installCommandDarwin?: string;
  checkCommand: string;
  size: string;
}

export interface CapabilityBucket {
  id: string;
  label: string;
  description: string;
  promptContext: string;
  capabilities: Capability[];
}

;

;

;

;

;

;

;

;

;

const webappBucket: CapabilityBucket = {
  id: "webapp",
  label: "Web Application",
  description:
    "Everything the agent needs for WSTG web application testing: core runtime, recon, injection, fuzzing, password cracking, traffic and secrets analysis.",
  promptContext: `You have a full Linux shell (run_bash) with: python3, gcc/g++, make, git, curl, wget,
netcat (nc), socat, ssh, file, strings, xxd, base64, openssl, jq, tmux, and standard
unix utilities. Python packages available (run_python_script): requests, pyyaml, beautifulsoup4,
Pillow, python-magic, chepy. You can install additional packages with python3 -m pip or apt if needed.
Write and run Python scripts for any complex logic. Use chepy for encoding/decoding chains.

Network capabilities available:
- nmap: nmap -sV -sC <target> — port scan with version detection and default scripts
- nmap -p-: full port range scan when a quick sweep misses services
- tcpdump: tcpdump -i eth0 -w capture.pcap — packet capture
- dig: dig @<dns_server> <domain> ANY — DNS enumeration
- hydra: hydra -l admin -P wordlist.txt <target> ssh — brute-force logins
- sqlmap: sqlmap -u "http://target/page?id=1" --batch --dbs
- msfvenom: msfvenom -p <payload> LHOST=<ip> LPORT=<port> -f <format> -o output — generate payloads
- john/hashcat: crack password hashes found via injection or dumps (hashid identifies unknown hashes)
- exiftool/tshark/binwalk: metadata extraction, packet capture, embedded-file analysis
- trufflehog/gitleaks: scan repos, archives and config dumps for leaked credentials
- s3scanner: check S3 buckets found in JS bundles for open access; firefox_decrypt for obtained Firefox profiles
Python: paramiko (SSH), dnspython (DNS), impacket (SMB/Kerberos/LDAP), pycryptodome, z3-solver

Web application capabilities available:
- nikto: nikto -h http://target — web server misconfiguration scanner
- nuclei: nuclei -u http://target — fast template-based vulnerability scanner
- commix: commix --url="http://target/page?cmd=id" — command injection
- jwt_tool: python3 jwt_tool.py <token> -T — JWT attack toolkit
- dalfox (network bucket): dalfox url "http://target/page?q=XSS" — XSS scanning and parameter analysis
- arjun: arjun -u http://target/page — HTTP parameter discovery
Python: PyJWT (JWT decode/encode)`,
  capabilities: [
    {
      name: "python3",
      type: "binary",
      bucket: "core",
      label: "Python 3",
      description: "Primary scripting runtime. The agent writes and runs .py scripts for almost everything.",
      installCommand: "apt install -y python3 python3-pip python3-venv",
      checkCommand: "which python3",
      size: "80 MB",
    },
    {
      name: "gcc",
      type: "binary",
      bucket: "core",
      label: "GCC / G++",
      description: "Compile C/C++ exploits, challenge sources, helper programs.",
      installCommand: "apt install -y build-essential",
      installCommandDarwin: "brew install gcc",
      checkCommand: "which gcc",
      size: "150 MB",
    },
    {
      name: "make",
      type: "binary",
      bucket: "core",
      label: "Make / CMake",
      description: "Build systems for compiling multi-file projects.",
      installCommand: "apt install -y make cmake",
      checkCommand: "which make",
      size: "15 MB",
    },
    {
      name: "git",
      type: "binary",
      bucket: "core",
      label: "Git",
      description: "Clone exploit repos, tools, challenge sources.",
      installCommand: "apt install -y git",
      checkCommand: "which git",
      size: "30 MB",
    },
    {
      name: "curl",
      type: "binary",
      bucket: "core",
      label: "curl / wget",
      description: "HTTP requests, file downloads.",
      installCommand: "apt install -y curl wget",
      checkCommand: "which curl",
      size: "5 MB",
    },
    {
      name: "nc",
      type: "binary",
      bucket: "core",
      label: "Netcat",
      description: "Raw TCP/UDP connections. Connect to challenge servers.",
      installCommand: "apt install -y netcat-openbsd",
      installCommandDarwin: "brew install netcat",
      checkCommand: "which nc",
      size: "1 MB",
    },
    {
      name: "socat",
      type: "binary",
      bucket: "core",
      label: "Socat",
      description: "Advanced relay/proxy. Upgrade shells, port forwarding, PTY wrapping.",
      installCommand: "apt install -y socat",
      checkCommand: "which socat",
      size: "2 MB",
    },
    {
      name: "ssh",
      type: "binary",
      bucket: "core",
      label: "SSH / sshpass",
      description: "Remote access to challenge machines.",
      installCommand: "apt install -y openssh-client sshpass",
      checkCommand: "which ssh",
      size: "5 MB",
    },
    {
      name: "file",
      type: "binary",
      bucket: "core",
      label: "file",
      description: "Identify file types. First thing to run on any unknown file.",
      installCommand: "apt install -y file",
      checkCommand: "which file",
      size: "1 MB",
    },
    {
      name: "strings",
      type: "binary",
      bucket: "core",
      label: "strings",
      description: "Extract printable strings from binaries, firmware, memory dumps.",
      installCommand: "apt install -y binutils",
      checkCommand: "which strings",
      size: "20 MB",
    },
    {
      name: "xxd",
      type: "binary",
      bucket: "core",
      label: "xxd",
      description: "Hex dump / reverse hex dump. Essential for binary data manipulation.",
      installCommand: "apt install -y xxd",
      checkCommand: "which xxd",
      size: "1 MB",
    },
    {
      name: "openssl",
      type: "binary",
      bucket: "core",
      label: "OpenSSL",
      description: "Quick crypto ops: hashing, cipher, certificate inspection, key generation.",
      installCommand: "apt install -y openssl",
      checkCommand: "which openssl",
      size: "5 MB",
    },
    {
      name: "jq",
      type: "binary",
      bucket: "core",
      label: "jq",
      description: "JSON parsing from shell.",
      installCommand: "apt install -y jq",
      checkCommand: "which jq",
      size: "2 MB",
    },
    {
      name: "tmux",
      type: "binary",
      bucket: "core",
      label: "tmux",
      description: "Session management. Run long processes, split work.",
      installCommand: "apt install -y tmux",
      checkCommand: "which tmux",
      size: "2 MB",
    },
    {
      name: "requests",
      type: "python_package",
      bucket: "core",
      label: "requests",
      description: "HTTP library. Default for any HTTP interaction.",
      installCommand: "python3 -m pip install requests",
      checkCommand: "python3 -c 'import requests'",
      size: "2 MB",
    },
    {
      name: "pyyaml",
      type: "python_package",
      bucket: "core",
      label: "PyYAML",
      description: "YAML parsing for challenge configs.",
      installCommand: "python3 -m pip install pyyaml",
      checkCommand: "python3 -c 'import yaml'",
      size: "1 MB",
    },
    {
      name: "beautifulsoup4",
      type: "python_package",
      bucket: "core",
      label: "BeautifulSoup4",
      description: "HTML/XML parsing.",
      installCommand: "python3 -m pip install beautifulsoup4",
      checkCommand: "python3 -c 'import bs4'",
      size: "1 MB",
    },
    {
      name: "Pillow",
      type: "python_package",
      bucket: "core",
      label: "Pillow",
      description: "Image manipulation. Used across stego, forensics, and misc.",
      installCommand: "python3 -m pip install Pillow",
      checkCommand: "python3 -c 'import PIL'",
      size: "15 MB",
    },
    {
      name: "python-magic",
      type: "python_package",
      bucket: "core",
      label: "python-magic",
      description: "Programmatic file command — detect MIME types in scripts.",
      installCommand: "python3 -m pip install python-magic",
      checkCommand: "python3 -c 'import magic'",
      size: "1 MB",
    },
    {
      name: "chepy",
      type: "python_package",
      bucket: "core",
      label: "Chepy",
      description:
        "CyberChef in Python. Encoding, decoding, hashing, compression, crypto — 300+ operations chained fluently.",
      installCommand: "python3 -m pip install chepy",
      checkCommand: "python3 -c 'import chepy'",
      size: "10 MB",
    },
    {
      name: "pexpect",
      type: "python_package",
      bucket: "core",
      label: "pexpect",
      description: "Expect-like automation for interactive CLI programs from Python.",
      installCommand: "python3 -m pip install pexpect",
      checkCommand: "python3 -c 'import pexpect'",
      size: "1 MB",
    },
    {
      name: "s3scanner",
      type: "binary",
      bucket: "network",
      label: "S3Scanner",
      description: "Finds open and misconfigured S3-compatible buckets and dumps their contents.",
      usageHint: "s3scanner scan -b bucket-name",
      installCommand: "pipx install s3scanner || python3 -m pip install --break-system-packages s3scanner",
      checkCommand: "which s3scanner",
      size: "10 MB",
    },
    {
      name: "trufflehog",
      type: "binary",
      bucket: "network",
      label: "TruffleHog",
      description:
        "Verified secret scanning across git history, filesystems, S3 buckets and container images.",
      usageHint: "trufflehog filesystem ./dir --only-verified; trufflehog git https://repo",
      installCommand:
        "curl -fsSL \"$(curl -fsSL https://api.github.com/repos/trufflesecurity/trufflehog/releases/latest | grep -o 'https://[^\\\"]*linux_amd64.tar.gz' | head -1)\" -o /tmp/th.tgz && tar -xzf /tmp/th.tgz -C /usr/local/bin trufflehog",
      installCommandDarwin: "brew install trufflehog",
      checkCommand: "which trufflehog",
      size: "40 MB",
    },
    {
      name: "gitleaks",
      type: "binary",
      bucket: "network",
      label: "Gitleaks",
      description: "Fast git-history secret scanner. Catches keys committed then deleted.",
      usageHint: "gitleaks detect --source . -v",
      installCommand:
        "curl -fsSL \"$(curl -fsSL https://api.github.com/repos/gitleaks/gitleaks/releases/latest | grep -o 'https://[^\\\"]*linux_x64.tar.gz' | head -1)\" -o /tmp/gl.tgz && tar -xzf /tmp/gl.tgz -C /usr/local/bin gitleaks",
      installCommandDarwin: "brew install gitleaks",
      checkCommand: "which gitleaks",
      size: "15 MB",
    },
    {
      name: "firefox_decrypt",
      type: "binary",
      bucket: "network",
      label: "firefox_decrypt",
      description:
        "Decrypts saved credentials from a Firefox profile (logins.json + key4.db). Used in Cloud Village 2024.",
      usageHint: "firefox_decrypt /path/to/profile",
      installCommand:
        "git clone --depth 1 https://github.com/unode/firefox_decrypt.git /opt/firefox_decrypt && printf '#!/bin/sh\\nexec python3 /opt/firefox_decrypt/firefox_decrypt.py \"$@\"\\n' > /usr/local/bin/firefox_decrypt && chmod +x /usr/local/bin/firefox_decrypt",
      checkCommand: "which firefox_decrypt",
      size: "5 MB",
    },
    {
      name: "nmap",
      type: "binary",
      bucket: "network",
      label: "Nmap",
      description:
        "Port scanner + service/version detection + NSE scripts. The starting point for any network challenge.",
      usageHint: "nmap -sV -sC <target> -oN scan.txt",
      installCommand: "apt install -y nmap",
      checkCommand: "which nmap",
      size: "25 MB",
    },
    {
      name: "john",
      type: "binary",
      bucket: "network",
      label: "John the Ripper",
      description: "CPU-based password/hash cracker. Supports 300+ hash formats.",
      usageHint: "john --wordlist=/usr/share/wordlists/rockyou.txt hashes.txt",
      installCommand: "apt install -y john",
      checkCommand: "which john",
      size: "30 MB",
    },
    {
      name: "hashcat",
      type: "binary",
      bucket: "network",
      label: "Hashcat",
      description: "GPU-accelerated hash cracker. Faster than john when GPU available.",
      usageHint: "hashcat -m <mode> hash.txt wordlist.txt",
      installCommand: "apt install -y hashcat",
      checkCommand: "which hashcat",
      size: "20 MB",
    },
    {
      name: "hashid",
      type: "binary",
      bucket: "network",
      label: "hashid",
      description: "Identify unknown hash types. Feed it a hash, get possible algorithms.",
      usageHint: "hashid '<hash_string>'",
      installCommand: "python3 -m pip install hashid",
      checkCommand: "which hashid",
      size: "1 MB",
    },
    {
      name: "pycryptodome",
      type: "python_package",
      bucket: "network",
      label: "PyCryptodome",
      description:
        "Full crypto toolkit. AES, RSA, DES, ChaCha20, hashing, PKCS padding, stream ciphers, MACs.",
      installCommand: "python3 -m pip install pycryptodome",
      checkCommand: "python3 -c 'import Crypto'",
      size: "15 MB",
    },
    {
      name: "z3-solver",
      type: "python_package",
      bucket: "network",
      label: "Z3 Solver",
      description:
        "SMT constraint solver from Microsoft. Solve systems of equations, bit-vector constraints, boolean satisfiability.",
      installCommand: "python3 -m pip install z3-solver",
      checkCommand: "python3 -c 'import z3'",
      size: "30 MB",
    },
    {
      name: "binwalk",
      type: "binary",
      bucket: "network",
      label: "Binwalk",
      description:
        "Scan firmware/binaries for embedded files, file systems, compressed data.",
      usageHint: "binwalk -e firmware.bin (auto-extract embedded files)",
      installCommand: "apt install -y binwalk",
      checkCommand: "which binwalk",
      size: "15 MB",
    },
    {
      name: "tshark",
      type: "binary",
      bucket: "network",
      label: "TShark",
      description: "CLI Wireshark. Parse pcap files, filter protocols, extract streams.",
      usageHint: "tshark -r capture.pcap -Y \"http\", tshark -r cap.pcap -z follow,tcp,ascii,0",
      installCommand: "apt install -y tshark",
      checkCommand: "which tshark",
      size: "80 MB",
    },
    {
      name: "exiftool",
      type: "binary",
      bucket: "network",
      label: "ExifTool",
      description: "Read/write metadata from images, PDFs, docs, videos, audio.",
      usageHint: "exiftool file.jpg",
      installCommand: "apt install -y libimage-exiftool-perl",
      checkCommand: "which exiftool",
      size: "25 MB",
    },
    {
      name: "oletools",
      type: "python_package",
      bucket: "network",
      label: "oletools",
      description: "Analyze Microsoft Office documents. Extract VBA macros, detect malicious content.",
      installCommand: "python3 -m pip install oletools",
      checkCommand: "python3 -c 'import oletools'",
      size: "5 MB",
    },
    {
      name: "p7zip",
      type: "binary",
      bucket: "network",
      label: "7-Zip",
      description: "Handle 7z, RAR, ISO, and other archive formats. Broader format support than unzip/tar.",
      usageHint: "7z x archive.7z OR 7z l archive.7z",
      installCommand: "apt install -y p7zip-full",
      checkCommand: "which 7z",
      size: "5 MB",
    },
    {
      name: "poppler-utils",
      type: "binary",
      bucket: "network",
      label: "Poppler Utils",
      description: "PDF text extraction and rendering. pdftotext, pdfimages, pdfinfo for analyzing PDF documents.",
      usageHint: "pdftotext document.pdf - OR pdfimages -all document.pdf images/",
      installCommand: "apt install -y poppler-utils",
      checkCommand: "which pdftotext",
      size: "10 MB",
    },
    {
      name: "tcpdump",
      type: "binary",
      bucket: "network",
      label: "tcpdump",
      description: "Lightweight packet capture. Faster to invoke than tshark for quick sniffing.",
      usageHint: "tcpdump -i eth0 -w capture.pcap",
      installCommand: "apt install -y tcpdump",
      checkCommand: "which tcpdump",
      size: "2 MB",
    },
    {
      name: "dig",
      type: "binary",
      bucket: "network",
      label: "dig / nslookup",
      description: "DNS lookups and zone transfers.",
      usageHint: "dig @<dns_server> <domain> ANY",
      installCommand: "apt install -y dnsutils",
      installCommandDarwin: "brew install bind",
      checkCommand: "which dig",
      size: "5 MB",
    },
    {
      name: "hydra",
      type: "binary",
      bucket: "network",
      label: "THC-Hydra",
      description: "Network brute-forcer. SSH, FTP, HTTP, SMB, SQL, etc.",
      usageHint: "hydra -l admin -P wordlist.txt <target> ssh",
      installCommand: "apt install -y hydra",
      checkCommand: "which hydra",
      size: "5 MB",
    },
    {
      name: "sqlmap",
      type: "binary",
      bucket: "network",
      label: "sqlmap",
      description: "Automated SQL injection detection and exploitation.",
      usageHint: "sqlmap -u \"http://target/page?id=1\" --batch --dbs",
      installCommand: "apt install -y sqlmap",
      checkCommand: "which sqlmap",
      size: "20 MB",
    },
    {
      name: "msfvenom",
      type: "binary",
      bucket: "network",
      label: "msfvenom",
      description:
        "Metasploit payload generator. Create reverse shells, meterpreter payloads, and encoded shellcode in various formats.",
      usageHint: "msfvenom -p linux/x64/shell_reverse_tcp LHOST=<ip> LPORT=<port> -f elf -o shell.elf",
      installCommand: "apt install -y metasploit-framework",
      installCommandDarwin: "brew install metasploit",
      checkCommand: "which msfvenom",
      size: "500 MB",
    },
    {
      name: "ffuf",
      type: "binary",
      bucket: "network",
      label: "ffuf",
      description: "Fast web fuzzer for directory and parameter brute-forcing.",
      installCommand: "apt install -y ffuf || go install github.com/ffuf/ffuf/v2@latest",
      checkCommand: "which ffuf",
      size: "10 MB",
    },
    {
      name: "feroxbuster",
      type: "binary",
      bucket: "network",
      label: "Feroxbuster",
      description: "Recursive content discovery tool written in Rust. Fast directory brute-forcing.",
      installCommand: "apt install -y feroxbuster",
      checkCommand: "which feroxbuster",
      size: "10 MB",
    },
    {
      name: "subfinder",
      type: "binary",
      bucket: "network",
      label: "Subfinder",
      description: "Fast passive subdomain enumeration tool.",
      installCommand: "apt install -y subfinder || go install github.com/projectdiscovery/subfinder/v2/cmd/subfinder@latest",
      checkCommand: "which subfinder",
      size: "15 MB",
    },
    {
      name: "httpx",
      type: "binary",
      bucket: "network",
      label: "httpx",
      description: "Fast multi-purpose HTTP toolkit for probing and fingerprinting.",
      installCommand: "apt install -y httpx || go install github.com/projectdiscovery/httpx/cmd/httpx@latest",
      checkCommand: "which httpx",
      size: "15 MB",
    },
    {
      name: "katana",
      type: "binary",
      bucket: "network",
      label: "Katana",
      description: "Next-generation crawling and spidering framework.",
      installCommand: "go install github.com/projectdiscovery/katana/cmd/katana@latest",
      checkCommand: "which katana",
      size: "15 MB",
    },
    {
      name: "whatweb",
      type: "binary",
      bucket: "network",
      label: "WhatWeb",
      description: "Web technology fingerprinting — identify CMS, frameworks, libraries.",
      installCommand: "apt install -y whatweb",
      checkCommand: "which whatweb",
      size: "10 MB",
    },
    {
      name: "wpscan",
      type: "binary",
      bucket: "network",
      label: "WPScan",
      description: "WordPress vulnerability scanner.",
      installCommand: "gem install wpscan",
      checkCommand: "which wpscan",
      size: "15 MB",
    },
    {
      name: "dalfox",
      type: "binary",
      bucket: "network",
      label: "DalFox",
      description: "Parameter analysis and XSS scanning tool.",
      installCommand: "go install github.com/hahwul/dalfox/v2@latest",
      checkCommand: "which dalfox",
      size: "10 MB",
    },
    {
      name: "gau",
      type: "binary",
      bucket: "network",
      label: "gau",
      description: "Fetch known URLs from AlienVault OTX, Wayback Machine, and Common Crawl.",
      installCommand: "go install github.com/lc/gau/v2/cmd/gau@latest",
      checkCommand: "which gau",
      size: "5 MB",
    },
    {
      name: "paramiko",
      type: "python_package",
      bucket: "network",
      label: "Paramiko",
      description: "SSH client library. Programmatic remote command execution.",
      installCommand: "python3 -m pip install paramiko",
      checkCommand: "python3 -c 'import paramiko'",
      size: "5 MB",
    },
    {
      name: "dnspython",
      type: "python_package",
      bucket: "network",
      label: "dnspython",
      description: "DNS toolkit. Queries, zone transfers, record manipulation from Python.",
      installCommand: "python3 -m pip install dnspython",
      checkCommand: "python3 -c 'import dns'",
      size: "2 MB",
    },
    {
      name: "impacket",
      type: "python_package",
      bucket: "network",
      label: "Impacket",
      description: "Network protocol library. SMB, LDAP, Kerberos, MSSQL. Essential for AD/Windows.",
      installCommand: "python3 -m pip install impacket",
      checkCommand: "python3 -c 'import impacket'",
      size: "20 MB",
    },
    {
      name: "nikto",
      type: "binary",
      bucket: "web",
      label: "Nikto",
      description: "Web server scanner. Detects dangerous files, outdated software, misconfigurations.",
      usageHint: "nikto -h http://target -o output.txt",
      installCommand: "apt install -y nikto",
      checkCommand: "which nikto",
      size: "5 MB",
    },
    {
      name: "nuclei",
      type: "binary",
      bucket: "web",
      label: "Nuclei",
      description: "Fast template-based vulnerability scanner. 9000+ templates for CVEs, misconfigs, exposures.",
      usageHint: "nuclei -u http://target -t /root/nuclei-templates",
      installCommand: "apt install -y nuclei || go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest",
      checkCommand: "which nuclei",
      size: "20 MB",
    },
    {
      name: "commix",
      type: "binary",
      bucket: "web",
      label: "Commix",
      description: "Automated command injection exploitation tool.",
      usageHint: "commix --url=\"http://target/page?cmd=id\"",
      installCommand: "apt install -y commix",
      checkCommand: "which commix",
      size: "10 MB",
    },
    {
      name: "arjun",
      type: "binary",
      bucket: "web",
      label: "Arjun",
      description: "HTTP parameter discovery. Find hidden GET/POST parameters.",
      usageHint: "arjun -u http://target/page",
      installCommand: "python3 -m pip install arjun",
      checkCommand: "which arjun",
      size: "5 MB",
    },
    {
      name: "jwt_tool",
      type: "binary",
      bucket: "web",
      label: "jwt_tool",
      description: "JWT attack toolkit. Algorithm confusion, none attack, brute-force secret.",
      usageHint: "python3 jwt_tool.py <token> -T",
      installCommand: "git clone https://github.com/ticarpi/jwt_tool /opt/jwt_tool && python3 -m pip install -r /opt/jwt_tool/requirements.txt && ln -sf /opt/jwt_tool/jwt_tool.py /usr/local/bin/jwt_tool",
      checkCommand: "which jwt_tool || test -f /opt/jwt_tool/jwt_tool.py",
      size: "5 MB",
    },
    {
      name: "PyJWT",
      type: "python_package",
      bucket: "web",
      label: "PyJWT",
      description: "Decode, encode and verify JWT tokens from Python scripts.",
      installCommand: "python3 -m pip install PyJWT",
      checkCommand: "python3 -c 'import jwt'",
      size: "1 MB",
    },
  ],
};

export const capabilityBuckets: CapabilityBucket[] = [
  webappBucket,
];

export const allCapabilities: Capability[] = capabilityBuckets.flatMap(
  (b) => b.capabilities
);

export function getCapabilityByName(name: string): Capability | undefined {
  return allCapabilities.find((c) => c.name === name);
}

/**
 * Find a capability matching a binary name or Python module that failed.
 * Tries exact name match first, then checks if checkCommand references the name.
 */
export function findCapabilityForCommand(missing: string): Capability | undefined {
  const lower = missing.toLowerCase().replace(/^['"]|['"]$/g, "");
  const exact = allCapabilities.find((c) => c.name.toLowerCase() === lower);
  if (exact) return exact;

  return allCapabilities.find((c) => {
    const check = c.checkCommand.toLowerCase();
    return check.includes(`which ${lower}`) || check.includes(`import ${lower}`);
  });
}

/**
 * Returns the install command for the given capability and OS.
 * On macOS (Darwin), uses installCommandDarwin if set, otherwise falls back to brew install.
 */
export function getInstallCommandForOS(cap: Capability, isDarwin: boolean): string {
  if (isDarwin) {
    if (cap.installCommandDarwin) return cap.installCommandDarwin;
    // pip/gem install commands work on both; apt commands need brew
    if (cap.installCommand.startsWith("apt ") || cap.installCommand.startsWith("apt-get ")) {
      return `brew install ${cap.name}`;
    }
    // Go-only install (no apt fallback) needs go first
    if (
      cap.installCommand.trimStart().startsWith("go install ") &&
      !cap.installCommand.includes("apt ")
    ) {
      return `brew install go && ${cap.installCommand}`;
    }
  }
  return cap.installCommand;
}

export function getBucketById(id: string): CapabilityBucket | undefined {
  return capabilityBuckets.find((b) => b.id === id);
}

export function getActiveBucketIds(selectedCapabilities: string[]): string[] {
  const bucketIds = new Set<string>();
  for (const name of selectedCapabilities) {
    const cap = getCapabilityByName(name);
    if (cap) bucketIds.add(cap.bucket);
  }
  return Array.from(bucketIds);
}

export function buildCapabilityPromptContext(
  installedCapabilities: string[]
): string {
  const activeBuckets = getActiveBucketIds(installedCapabilities);
  const sections: string[] = [];

  for (const bucketId of activeBuckets) {
    const bucket = getBucketById(bucketId);
    if (!bucket) continue;

    const installed = bucket.capabilities.filter((c) =>
      installedCapabilities.includes(c.name)
    );
    if (installed.length === 0) continue;

    const lines = installed.map((c) => {
      const hint = c.usageHint ? `: ${c.usageHint}` : "";
      return `- ${c.label} (${c.name})${hint} — ${c.description}`;
    });

    sections.push(`${bucket.label}:\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}

export function buildDetectionScript(capabilityNames: string[]): string {
  const checks: string[] = [];
  for (const name of capabilityNames) {
    const cap = getCapabilityByName(name);
    if (!cap) continue;
    // Brace-group the check so the redirect silences a multi-command
    // checkCommand too — otherwise a leading `which` leaks its path into the
    // "name:yes" line and the parser reads the tool as missing.
    checks.push(
      `echo -n "${cap.name}:"; { ${cap.checkCommand}; } > /dev/null 2>&1 && echo "yes" || echo "no"`
    );
  }
  // Detection runs over non-interactive SSH, which does not source ~/.bashrc, so
  // user-local installs (~/.local/bin from pipx and root-less installers, ~/go/bin
  // from `go install`) would otherwise be reported as missing even when present.
  // Must match the prefix used in work-host.service.ts so detection and execution agree.
  const pathPrefix = 'export PATH="$HOME/.local/bin:$HOME/go/bin:$PATH"';
  return [pathPrefix, ...checks].join(" ; ");
}

export function parseDetectionOutput(
  output: string
): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  const lines = output.split("\n").filter(Boolean);
  for (const line of lines) {
    const [name, status] = line.split(":");
    if (name && status) {
      result[name.trim()] = status.trim() === "yes";
    }
  }
  return result;
}
