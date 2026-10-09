#!/bin/bash
set -euo pipefail
# Root does not inspect, write, chown, or execute anything in the runtime home.
# All package, service, journal and profile operations happen after setuid.
SCRIPT_DIR=$(cd -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd)
[ "$(/usr/bin/id -u)" -eq 0 ] || { echo 'Run as root (the helper immediately drops privilege).' >&2; exit 1; }
UID_RUNTIME=$(/usr/bin/id -u openclaw)
exec /usr/sbin/runuser -u openclaw -- /usr/bin/env -i \
  HOME=/home/openclaw USER=openclaw LOGNAME=openclaw \
  PATH=/usr/local/bin:/usr/bin:/bin \
  XDG_RUNTIME_DIR="/run/user/$UID_RUNTIME" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$UID_RUNTIME/bus" \
  /usr/bin/python3 "$SCRIPT_DIR/openclaw_runtime_migration.py" "$@"
