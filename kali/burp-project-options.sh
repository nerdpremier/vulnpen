#!/usr/bin/env bash
# Generate the project-config document the Burp autostart hands to
# `burpsuite --config-file`, with the proxy listener already bound to all
# interfaces so nothing has to be rebound by clicking through the UI.
#
# Two details make this work, both established by experiment against Burp
# 2026.8:
#   * the listener lives under the TOP-LEVEL "proxy" key - a hand-written
#     minimal document nesting it under "project_options" is ignored outright
#     and the listener silently stays on loopback;
#   * start from the defaults Burp ships at
#     resources/Preferences/ProjectDefaults.json inside burpsuite.jar, so the
#     document always matches the installed version and stays valid.
# "all_interfaces" is the ALL_INTERFACES enum name lowercased, the counterpart
# of the "loopback_only" the shipped default uses.
set -euo pipefail

JAR=/usr/share/burpsuite/burpsuite.jar
OUT=/opt/burp-project-options.json

unzip -p "$JAR" resources/Preferences/ProjectDefaults.json > "$OUT"

python3 - "$OUT" <<'PY'
import json, sys

path = sys.argv[1]
with open(path) as fh:
    config = json.load(fh)

listeners = config["proxy"]["request_listeners"]
if not listeners:
    raise SystemExit("no request_listeners in ProjectDefaults.json")

listeners[0]["certificate_mode"] = "per_host"
listeners[0]["listen_mode"] = "all_interfaces"
listeners[0]["listener_port"] = 8080
listeners[0]["running"] = True

with open(path, "w") as fh:
    json.dump(config, fh, indent=2)

print("burp project options: proxy listener -> all interfaces on :8080")
PY

# Verify the generated document is usable, so a broken one fails the build
# instead of shipping an image whose autostart falls back to GUI clicking.
python3 - "$OUT" <<'PY'
import json, sys

config = json.load(open(sys.argv[1]))
listener = config["proxy"]["request_listeners"][0]
assert listener["listen_mode"] == "all_interfaces", listener
assert listener["listener_port"] == 8080, listener
assert listener["running"] is True, listener
print("verified listener:", listener)
PY