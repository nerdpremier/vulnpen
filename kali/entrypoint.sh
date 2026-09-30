#!/usr/bin/env bash
set -e

mkdir -p /var/run/sshd

KALI_ROOT_PASSWORD="$(sed -n '/^KALI_ROOT_PASSWORD=/{s/^[^=]*=//; s/^"//; s/"$//; p;}' /run/vulnpen.env | tail -1)"
if [ -z "$KALI_ROOT_PASSWORD" ]; then
    echo "ERROR: KALI_ROOT_PASSWORD is not configured" >&2
    exit 1
fi
echo "root:${KALI_ROOT_PASSWORD}" | chpasswd
VNC_SEED_PASSWORD="$KALI_ROOT_PASSWORD"
unset KALI_ROOT_PASSWORD

# Start SSH — use the daemon directly so we get a clean PID and proper error reporting
/usr/sbin/sshd -D &
SSHD_PID=$!

# Wait briefly and verify sshd is alive
sleep 1
if ! kill -0 "$SSHD_PID" 2>/dev/null; then
    echo "ERROR: sshd failed to start" >&2
    exit 1
fi
echo "sshd running (pid $SSHD_PID)"

# Launch shellinabox on port 4200 (no SSL) for browser-based shell access
shellinaboxd --disable-ssl --port 4200 -s "/:LOGIN" &

# If an OpenVPN configuration exists, start the OpenVPN service
if [ -f /etc/openvpn/server.conf ]; then
    echo "Starting OpenVPN server..."
    openvpn --config /etc/openvpn/server.conf &
fi

# ── Autostart: GUI desktop (:89), noVNC (:9020) and Burp Suite ──────────────
VNC_DISPLAY=":89"
VNC_RFB_PORT="5989"
VNC_NOVNC_PORT="9020"

start_vnc_desktop() {
    # VNC password: reuse the existing file, else seed it from the root password.
    mkdir -p /root/.vnc
    if [ ! -s /root/.vnc/passwd ]; then
        echo "$VNC_SEED_PASSWORD" | x11vnc -storepasswd /root/.vnc/passwd >/dev/null 2>&1 || \
            echo "$VNC_SEED_PASSWORD" | vncpasswd -f > /root/.vnc/passwd
        chmod 600 /root/.vnc/passwd
    fi

    # Desktop session: prefer Xfce, fall back to xterm.
    cat > /root/.vnc/xstartup <<'XS'
#!/bin/bash
export DISPLAY=:89
[ -f $HOME/.Xresources ] && xrdb $HOME/.Xresources
if command -v startxfce4 >/dev/null 2>&1; then
  startxfce4 &
else
  xterm &
fi
XS
    chmod +x /root/.vnc/xstartup

    # A container restart keeps the filesystem, so the previous run's X lock
    # and socket survive and Xvnc refuses to start ("Server is already active
    # for display 89"). No X server can pre-exist at entrypoint time — clear
    # them unconditionally.
    rm -f "/tmp/.X${VNC_DISPLAY#:}-lock" "/tmp/.X11-unix/X${VNC_DISPLAY#:}"

    Xvnc "$VNC_DISPLAY" -geometry 1280x800 -depth 24 -rfbport "$VNC_RFB_PORT" \
        -rfbauth /root/.vnc/passwd >/tmp/xvnc.log 2>&1 &
    sleep 3
    /root/.vnc/xstartup >/tmp/xstartup.log 2>&1 &
    websockify --web /usr/share/novnc/ "$VNC_NOVNC_PORT" "localhost:$VNC_RFB_PORT" >/dev/null 2>&1 &
    echo "VNC desktop up ($VNC_DISPLAY rfb=$VNC_RFB_PORT noVNC=$VNC_NOVNC_PORT)"
}

launch_burp_flow() {
    # Burp Community always shows its startup wizard and a temporary project
    # forgets the extension + listener bind between runs. Buttons are found by
    # scanning for Burp's orange primary-button colour (ImageMagick pixel scan
    # -> centroid -> xte click), which survives dialog layout shifts.

    # Ensure the orange-button clicker exists (installed into the image via the
    # Dockerfile, but generate it here too so rebuilt images need no extra file).
    if [ ! -x /usr/local/bin/click_orange.sh ]; then
        cat > /usr/local/bin/click_orange.sh <<'CO'
#!/usr/bin/env bash
export DISPLAY="${DISPLAY:-:89}"
GEOM="$1"; TRIES="${2:-1}"; INTERVAL="${3:-5}"
CROP_X="${GEOM#*+}"; CROP_X="${CROP_X%%+*}"
CROP_Y="${GEOM##*+}"
for _ in $(seq 1 "$TRIES"); do
  XY=$(xwd -root -silent | convert xwd:- -crop "$GEOM" +repage txt:- 2>/dev/null |     awk -F"[,:() ]+" -v ox="$CROP_X" -v oy="$CROP_Y"       'NR>1 && $3>200 && $4>60 && $4<160 && $5<90 { s++; sx+=$1; sy+=$2 }       END { if (s>50) printf "%d %d", int(sx/s)+ox, int(sy/s)+oy }')
  if [ -n "$XY" ]; then
    xte "mousemove $XY" "mouseclick 1"
    echo "clicked orange at $XY"
    exit 0
  fi
  sleep "$INTERVAL"
done
echo "no orange button found in $GEOM"
exit 1
CO
        chmod +x /usr/local/bin/click_orange.sh
    fi

    (
        export DISPLAY="$VNC_DISPLAY"
        port_free() { ss -tln 2>/dev/null | grep -q "$1"; }

        for _ in $(seq 1 30); do xdpyinfo >/dev/null 2>&1 && break; sleep 1; done
        # Stale temp files trigger a "Delete old temporary files?" dialog that
        # would swallow the wizard clicks — remove them up front.
        rm -rf /tmp/burp*.tmp 2>/dev/null || true

        setsid nohup burpsuite --use-defaults >/tmp/burp.log 2>&1 </dev/null &

        # Wizard: Next (temporary project) then Start Burp — both orange, both
        # in the lower-right region. Stop once the proxy port is listening.
        sleep 40
        for _ in $(seq 1 30); do
            port_free ":8080" && break
            click_orange.sh "260x220+860+480" 1 3 || true
            sleep 3
        done
        for _ in $(seq 1 20); do port_free ":8080" && break; sleep 3; done

        # Load the burp-rpc extension (gRPC binds 0.0.0.0:50051). The file
        # field renders at slightly different y offsets per boot — try each.
        if ! port_free ":50051"; then
            xte "mousemove 848 81" "mouseclick 1"    # Extensions tab
            sleep 3
            xte "mousemove 60 269" "mouseclick 1"    # Add button
            sleep 3
            for FY in 340 327 353 317; do
                xte "mousemove 551 $FY" "mouseclick 1"
                sleep 1
                xte "str /opt/burp-rpc.jar"
                sleep 1
                click_orange.sh "260x220+860+480" 2 4 && sleep 10
                port_free ":50051" && break
            done
        fi

        # Rebind the proxy listener to all interfaces.
        if ss -tln 2>/dev/null | grep ":8080" | grep -q "127.0.0.1"; then
            xte "mousemove 173 81" "mouseclick 1"    # Proxy tab
            sleep 3
            xte "mousemove 551 117" "mouseclick 1"   # Proxy settings
            sleep 3
            xte "mousemove 600 256" "mouseclick 1"   # listener row
            sleep 1
            xte "mousemove 438 256" "mouseclick 1"   # Edit
            sleep 3
            xte "mousemove 456 375" "mouseclick 1"   # All interfaces radio
            sleep 2
            xte "mousemove 836 628" "mouseclick 1"   # OK
            sleep 2
            click_orange.sh "240x120+660+420" 5 5    # confirm Yes
            sleep 4
            if ss -tln 2>/dev/null | grep ":8080" | grep -q "127.0.0.1"; then
                xte "mousemove 600 268" "mouseclick 1"
                sleep 1
                xte "mousemove 438 269" "mouseclick 1"
                sleep 3
                xte "mousemove 456 388" "mouseclick 1"
                sleep 2
                xte "mousemove 836 641" "mouseclick 1"
                sleep 2
                click_orange.sh "240x120+660+433" 5 5
            fi
        fi
        echo "Burp Suite started (wizard + burp-rpc + all-interfaces listener)"
    )
}

start_burp() { launch_burp_flow & }

# Watchdog: if the Burp window gets closed (or crashes) while the desktop is
# up, relaunch the whole flow — wizard clicks included.
burp_watchdog() {
    while true; do
        sleep 30
        if [ -S "/tmp/.X11-unix/X${VNC_DISPLAY#:}" ] &&            ! ps aux 2>/dev/null | grep -q "[b]urpsuite.jar"; then
            echo "Burp not running; relaunching via watchdog"
            launch_burp_flow &
        fi
    done
}

if command -v Xvnc >/dev/null 2>&1; then
    start_vnc_desktop || true
    if command -v burpsuite >/dev/null 2>&1 && command -v xte >/dev/null 2>&1; then
        start_burp
        burp_watchdog &
    else
        echo "Burp autostart skipped (missing burpsuite or xautomation)" >&2
    fi
fi

# Keep the container running
wait "$SSHD_PID"
