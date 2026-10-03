FROM kalilinux/kali-rolling

ENV USER=root
ENV DEBIAN_FRONTEND=noninteractive

# -- Mirror setup -------------------------------------------------------------
# The base image points at http.kali.org, a geo-DNS CDN that redirects to slow
# university mirrors; large .deb downloads (gcc-16, 87 MB) stalled on top of that.
# Changing sources.list alone is NOT sufficient: apt bakes absolute archive URLs
# into the downloaded Packages files, so /usr/local/bin/apti rewrites those too.
RUN set -eux; \
    rm -f /etc/apt/sources.list.d/debian.sources; \
    printf '%s\n' \
      'deb http://kali.download/kali kali-rolling main contrib non-free non-free-firmware' \
      > /etc/apt/sources.list; \
    printf 'Acquire::http::Timeout "60";\nAcquire::https::Timeout "60";\nAcquire::Retries "5";\n' \
      > /etc/apt/apt.conf.d/99-vulnpen-tune

# Resilient apt wrapper: refresh index, force the fast mirror, retry on failure,
# and report (rather than silently drop) any tool that still will not install.
COPY apti.sh /usr/local/bin/apti
RUN chmod +x /usr/local/bin/apti

# -- Layer 1: SSH + services (small, rarely changes) --
RUN apti \
      openssh-server \
      shellinabox \
      openvpn

# Configure SSH for root login with the password supplied at runtime.
RUN mkdir -p /var/run/sshd && \
    sed -i 's/^#*\s*PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config && \
    sed -i 's/^#*\s*PermitEmptyPasswords.*/PermitEmptyPasswords no/' /etc/ssh/sshd_config && \
    sed -i 's/^#*\s*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config && \
    sed -i 's/^#*\s*UsePAM.*/UsePAM no/' /etc/ssh/sshd_config && \
    grep -q '^PermitRootLogin' /etc/ssh/sshd_config    || echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config && \
    grep -q '^PermitEmptyPasswords' /etc/ssh/sshd_config || echo 'PermitEmptyPasswords no' >> /etc/ssh/sshd_config && \
    grep -q '^PasswordAuthentication' /etc/ssh/sshd_config || echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config && \
    grep -q '^UsePAM' /etc/ssh/sshd_config              || echo 'UsePAM no' >> /etc/ssh/sshd_config

EXPOSE 22 4200 1194/udp 9020


# -- Layer 2: Base utilities + build deps (needed for runtime tool installs) --
RUN apti \
      build-essential curl git wget unzip tar \
      python3 python3-pip python3-venv pipx \
      golang \
      iputils-ping net-tools dnsutils \
      nano bash-completion

# -- Layer 3: Core pentest tools (the essentials that should be pre-installed) --
# NOTE: masscan is intentionally not listed here. Its single .deb on the rolling
# mirror (masscan_1.3.2+ds1-2_amd64.deb) does not download - it times out even with a
# correct, encoded URL, while sibling files in the same pool directory work.
# Keeping it out of the required list means the build cannot fail on it; install it
# later at runtime with `apti masscan` if the mirror ever serves it again.
RUN apti \
      nmap \
      sqlmap \
      ffuf gobuster feroxbuster \
      hydra \
      nikto \
      whatweb \
      libpcap-dev

# -- Layer 4: Desktop / VNC (required for noVNC & GUI access) --
RUN apti \
      xfce4 xfce4-goodies tightvncserver novnc websockify \
      xterm dbus-x11 fonts-dejavu-core xfonts-base firefox-esr \
      fonts-noto-core fonts-thai-tlwg

# Default noVNC scaling mode to Local scaling instead of Remote resizing
RUN sed -i "s/initSetting('resize', 'off')/initSetting('resize', 'scale')/" /usr/share/novnc/app/ui.js

# -- Layer 5: Kali core tooling --
RUN apti \
      kali-linux-headless \
      kali-linux-core

# -- Optional: kali-linux-default (uncomment for the full default tool suite) --
# WARNING: Adds ~500 extra packages and significant build time on top of core.
# RUN apti kali-linux-default

# -- Layer 6: Burp Suite + the desktop-automation deps its autostart needs --
# entrypoint.sh opens Burp on the :89 desktop, drives its startup wizard with
# synthetic X events, rebinds the proxy listener and loads the burp-rpc gRPC
# bridge the backend's Burp tools talk to. That needs more than the desktop
# layer provides:
#   burpsuite   - the Community launcher + jar the autostart runs
#   xautomation - xte, the synthetic pointer/keyboard driver for the clicks
#   imagemagick - convert, the pixel scan that locates Burp's orange buttons
#   x11-apps    - xwd, which dumps the root window for that scan
#   procps      - pgrep, used by the Burp watchdog to notice Burp exiting
#   wmctrl      - closes the leftover Settings window, by name, at startup
# Without them the entrypoint's guard skips Burp entirely ("Burp autostart
# skipped") and the GUI shows a desktop with no Burp window in it.
RUN apti \
      burpsuite xautomation imagemagick x11-apps procps x11-utils wmctrl

# burp-rpc is the Burp extension that exposes Burp over gRPC on
# 0.0.0.0:50051; the backend's burp_* tools and the BURP panel connect to
# that port, so the container cannot do Burp work without it. entrypoint.sh
# loads it from this exact path (BURP_USER_CONFIG ->
# extender.extensions[0].extension_file), so the name and location are a
# contract, not a preference. Pin the URL to a release tag to freeze the
# version; the default tracks the latest published jar.
ARG BURP_RPC_JAR_URL="https://github.com/shero4/burp-rpc/releases/latest/download/burp-rpc.jar"
RUN curl -fsSL --retry 3 --retry-delay 5 --max-time 900 -o /opt/burp-rpc.jar "$BURP_RPC_JAR_URL" \
    && unzip -l /opt/burp-rpc.jar > /dev/null \
    && ls -l /opt/burp-rpc.jar

# Bake the project-config document the autostart passes to `burpsuite
# --config-file`, with the proxy listener already on all interfaces. Generating
# it at build time keeps the structure in step with the installed Burp and
# removes the need for the coordinate-click rebind at start.
COPY burp-project-options.sh /usr/local/bin/burp-project-options
RUN chmod +x /usr/local/bin/burp-project-options && burp-project-options

# Entrypoint is copied last on purpose: it changes far more often than the
# package layers above, and keeping it here means editing it rebuilds in
# seconds instead of reinstalling Burp, the desktop and the browser stack.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Additional security tools (Go-based & Python-based - uncomment to pre-install)
COPY tools.sh /tools.sh
RUN chmod +x /tools.sh
# RUN /tools.sh

ENTRYPOINT ["/entrypoint.sh"]
