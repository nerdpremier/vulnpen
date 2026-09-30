#!/usr/bin/env bash
# apti - resilient apt wrapper for the VulnPen Kali image.
#
# Why this exists: the base image points at http.kali.org, a geo-DNS CDN that
# redirects to slow university mirrors, and its own CDN rate-limits by IP. On this
# machine that produced three separate failures:
#   * large .deb downloads (gcc-16, 87 MB) stalling for minutes,
#   * 403 Forbidden from the primary mirror after several hundred packages,
#   * a couple of files the primary mirror refused outright.
# None of those should fail a build, so this helper:
#   1. registers several mirrors so apt can fail over on its own,
#   2. rewrites archive URLs baked into the downloaded Packages/Release files,
#   3. retries the whole install, re-syncing the index between attempts,
#   4. reports (instead of silently dropping) anything still missing.
set -uo pipefail

MIRRORS=(
  "http://kali.download/kali"
  "http://mirror.kku.ac.th/kali"
  "http://ftp.halifax.rwth-aachen.de/kali"
)
PRIMARY="${MIRRORS[0]}"

APT_OPTS=(
  -o Acquire::http::Timeout=60
  -o Acquire::https::Timeout=60
  -o Acquire::Retries=5
  -o Acquire::http::No-Cache=true
)

write_sources() {
  local f line
  f=/etc/apt/sources.list
  : > "$f"
  for line in "${MIRRORS[@]}"; do
    printf 'deb %s kali-rolling main contrib non-free non-free-firmware\n' "$line" >> "$f"
  done
}

# apt stores absolute archive URLs in the index files, so a mirror listed in
# sources.list is not necessarily the one used to fetch the .deb.
fix_lists() {
  shopt -s nullglob
  local f m
  for f in /var/lib/apt/lists/*Packages /var/lib/apt/lists/*Packages*; do
    [ -f "$f" ] || continue
    for m in "${MIRRORS[@]}" http://http.kali.org/kali http://https.kali.org/kali; do
      sed -i "s|${m}|${PRIMARY}|g" "$f" 2>/dev/null || true
    done
  done
  for f in /var/lib/apt/lists/*_InRelease /var/lib/apt/lists/*_Release; do
    [ -f "$f" ] || continue
    for m in "${MIRRORS[@]}" http://http.kali.org/kali; do
      sed -i "s|${m}|${PRIMARY}|g" "$f" 2>/dev/null || true
    done
  done
}

# Packages that the mirror has been observed to refuse. They are pulled in as
# hard dependencies (masscan is required by kali-linux-headless), so they cannot
# simply be dropped from the package list - instead the .deb is fetched from a
# working mirror and installed with dpkg before apt runs.
BLACKLIST=(masscan)

prefetch_blacklisted() {
  local pkg url ver path
  for pkg in "${BLACKLIST[@]}"; do
    dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "ok installed" && continue

    path=$(apt-get --print-uris --yes install "$pkg" 2>/dev/null \
            | awk -v p="$pkg" '$0 ~ p {print $NF}' | head -1)
    if [ -z "$path" ]; then
      echo "apti: prefetch: cannot resolve $pkg, skipping" >&2
      continue
    fi

    url=$(apt-get --print-uris --yes install "$pkg" 2>/dev/null \
            | grep -o "http[^ ]*$path" | head -1)
    [ -n "$url" ] || url="${PRIMARY}/${path}"

    local m ok=0
    for m in "${MIRRORS[@]}" http://http.kali.org/kali; do
      local alt="${m}/${path}"
      if curl -fsSL --max-time 300 -o /tmp/vulnpen-pkg.deb "$alt" 2>/dev/null; then
        echo "apti: prefetched $pkg from $alt"
        dpkg -i --force-depends /tmp/vulnpen-pkg.deb >/dev/null 2>&1 || true
        ok=1
        break
      fi
    done
    [ "$ok" -eq 1 ] || echo "apti: prefetch: failed for $pkg (will retry via apt)" >&2
    rm -f /tmp/vulnpen-pkg.deb
  done
}

update_index() {
  local n
  for n in 1 2 3 4 5; do
    if apt-get "${APT_OPTS[@]}" update; then
      fix_lists
      return 0
    fi
    echo "apti: apt-get update failed (attempt ${n}/5), retrying..." >&2
    sleep $((n * 10))
  done
  echo "apti: giving up on apt-get update" >&2
  return 1
}

[ "$#" -gt 0 ] || { echo "apti: no packages given" >&2; exit 2; }

write_sources
update_index || exit 1
prefetch_blacklisted

ok=0
for n in 1 2 3 4 5 6; do
  if apt-get "${APT_OPTS[@]}" install -y --no-install-recommends --fix-missing "$@"; then
    ok=1
    break
  fi
  echo "apti: install failed (attempt ${n}/6); cooling down, then retrying..." >&2
  # The rate limit is per-IP and short-lived, so backing off matters more than
  # hammering the mirror again immediately.
  sleep $((n * 15))
  update_index || true
done

if [ "$ok" -ne 1 ]; then
  echo "apti: FAILED to install: $*" >&2
  exit 1
fi

missing=()
for p in "$@"; do
  case "$p" in
    *://*|*=*|/*) continue ;;
  esac
  if ! dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "ok installed"; then
    missing+=("$p")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "apti: WARNING - not installed after retries: ${missing[*]}" >&2
fi

apt-get "${APT_OPTS[@]}" clean || true
rm -rf /var/lib/apt/lists/*
exit 0