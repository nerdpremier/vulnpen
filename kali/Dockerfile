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
      xterm dbus-x11 fonts-dejavu-core xfonts-base firefox-esr

# Default noVNC scaling mode to Local scaling instead of Remote resizing
RUN sed -i "s/initSetting('resize', 'off')/initSetting('resize', 'scale')/" /usr/share/novnc/app/ui.js

# -- Layer 5: Kali core tooling --
RUN apti \
      kali-linux-headless \
      kali-linux-core

# -- Optional: kali-linux-default (uncomment for the full default tool suite) --
# WARNING: Adds ~500 extra packages and significant build time on top of core.
# RUN apti kali-linux-default

# Additional security tools (Go-based & Python-based - uncomment to pre-install)
# Entrypoint is copied last on purpose: it changes far more often than the
# package layers above, and keeping it here means editing it rebuilds in
# seconds instead of reinstalling Burp, the desktop and the browser stack.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

COPY tools.sh /tools.sh
RUN chmod +x /tools.sh
# RUN /tools.sh

ENTRYPOINT ["/entrypoint.sh"]
