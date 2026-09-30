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

# Burp keeps loaded extensions, listeners and its window layout in this file.
# The heredoc body is intentionally flush left: the JSON must start at column 0.
BURP_USER_CONFIG="/root/.BurpSuite/UserConfig.json"
ensure_burp_user_config() {
    [ -s "$BURP_USER_CONFIG" ] && return 0
    mkdir -p /root/.BurpSuite
    cat > "$BURP_USER_CONFIG" <<'BURPCFG'
{
  "user_options": {
    "extender": {
      "extensions": [
        {
          "auto_reload": false,
          "errors": "ui",
          "extension_file": "/opt/burp-rpc.jar",
          "extension_type": "java",
          "loaded": true,
          "name": "Burp RPC Bridge",
          "output": "ui",
          "use_ai": false
        }
      ]
    }
  }
}
BURPCFG
    echo "Seeded a Burp user config that loads burp-rpc at startup"
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

        # --use-defaults discards /root/.BurpSuite/UserConfig.json, and that file is
        # where Burp records the loaded burp-rpc extension (gRPC 0.0.0.0:50051).
        # Discarding it is why the RPC bridge never came back after a restart, so
        # the saved config is loaded instead (and seeded above on a fresh install).
        ensure_burp_user_config

        # Proxy listeners are project options, so a temporary project resets the
        # bind to loopback on every boot; the rebind below re-applies it via the
        # Settings UI.
        setsid nohup burpsuite --user-config-file="$BURP_USER_CONFIG" >/tmp/burp.log 2>&1 </dev/null &

        # Wizard: Next (temporary project) then Start Burp — both orange, both
        # in the lower-right region. Stop once the proxy port is listening.
        # Instead of a fixed sleep, poll for the Burp window so clicking starts
        # the moment the wizard is actually on screen.
        burp_window_up() {
            xwininfo -name "burp-StartBurp" >/dev/null 2>&1
        }
        for _ in $(seq 1 90); do burp_window_up && break; sleep 1; done
        for _ in $(seq 1 60); do
            port_free ":8080" && break
            click_orange.sh "260x220+860+480" 1 1 || true
            sleep 1
        done
        for _ in $(seq 1 30); do port_free ":8080" && break; sleep 1; done

        # The saved user config loads burp-rpc at startup, so give the bridge a
        # moment before falling back to the click-driven load below.
        for _ in $(seq 1 30); do port_free ":50051" && break; sleep 1; done
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

        # Rebind the proxy listener to all interfaces. The Edit-listener dialog
        # opens at a slightly different position on every boot, so the in-dialog
        # clicks are computed relative to the dialog's live geometry (xwininfo)
        # instead of hard-coded screen coordinates.
        dialog_origin() {
            xwininfo -name "Edit proxy listener" 2>/dev/null | awk '
                /Absolute upper-left X/ {x = $4}
                /Absolute upper-left Y/ {y = $4}
                END {print x + 0, y + 0}'
        }

        rebind_listener() {
            xte "mousemove 700 219" "mouseclick 1"   # listener row
            sleep 1
            xte "mousemove 461 222" "mouseclick 1"   # Edit
            # Poll briefly for the Edit dialog instead of a fixed sleep.
            for _ in $(seq 1 10); do
                read DIALOG_X DIALOG_Y <<EOF
            $(dialog_origin)
EOF
                [ "$DIALOG_X" -gt 0 ] && break
                sleep 1
            done
            # A zero origin means the dialog was not found — don't click blind.
            [ "$DIALOG_X" -gt 0 ] || return 1
            xte "mousemove $((DIALOG_X + 145)) $((DIALOG_Y + 189))" "mouseclick 1"  # All interfaces radio
            sleep 1
            xte "mousemove $((DIALOG_X + 546)) $((DIALOG_Y + 432))" "mouseclick 1"  # OK
            sleep 2
            click_orange.sh "240x120+$((DIALOG_X + 365))+$((DIALOG_Y + 225))" 5 2   # confirm Yes
        }

        if ss -tln 2>/dev/null | grep ":8080" | grep -q "127.0.0.1"; then
            xte "mousemove 173 81" "mouseclick 1"    # Proxy tab
            sleep 2
            xte "mousemove 551 117" "mouseclick 1"   # Proxy settings
            sleep 2
            rebind_listener || true
            sleep 3
            if ss -tln 2>/dev/null | grep ":8080" | grep -q "127.0.0.1"; then
                rebind_listener || true              # one retry pass
            fi
        fi
        echo "Burp Suite started (wizard + burp-rpc + all-interfaces listener)"
    )
}

start_burp() { launch_burp_flow & }

# Watchdog: if the Burp window gets closed (or crashes) while the desktop is
# up, relaunch the whole flow — wizard clicks included. Event-driven: the loop
# blocks on the live Burp pid itself (`tail --pid` returns exactly when the
# process exits), so there is no fixed polling interval to wait out.
burp_watchdog() {
    # Initial start is done by start_burp; block here until that pid exists
    # so the watchdog never double-launches on boot.
    until BPID="$(pgrep -f '[b]urpsuite.jar' | head -1)" && [ -n "$BPID" ]; do
        sleep 5
    done
    while true; do
        BPID="$(pgrep -f '[b]urpsuite.jar' | head -1)"
        if [ -n "$BPID" ]; then
            tail --pid="$BPID" -f /dev/null 2>/dev/null
            echo "Burp closed (pid $BPID); relaunching via watchdog"
        fi
        launch_burp_flow &
        # Grace period so a failed relaunch can't spin the loop; after it the
        # loop simply re-attaches to whatever Burp pid is (or is not) running.
        sleep 120
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
