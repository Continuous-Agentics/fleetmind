/**
 * AWS SSM commands execute as root, while FleetMind gateways are user-systemd
 * services. Keep the user-session environment in one place so every SSM
 * operation reaches the same systemd --user instance.
 */

export const DEFAULT_AWS_RUNTIME_USER = "openclaw";
export const AWS_RUNTIME_USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

/** Execute selection only after sudo drops privilege. Older root-managed hosts
 * without a selector retain PATH behavior; selected hosts fail closed. */
export const AWS_RUNTIME_SELECTION = `sh -c 'if [ -e "$HOME/.config/fleetmind/openclaw-runtime.json" ] || [ -L "$HOME/.config/fleetmind/openclaw-runtime.json" ]; then [ -r "$HOME/.config/fleetmind/openclaw-runtime.sh" ] || exit 78; . "$HOME/.config/fleetmind/openclaw-runtime.sh"; [ -n "$FLEETMIND_OPENCLAW_BIN" ] && [ -x "$FLEETMIND_OPENCLAW_BIN" ] || exit 78; if [ "$1" = openclaw ]; then shift; exec "$FLEETMIND_OPENCLAW_BIN" "$@"; fi; fi; exec "$@"' --`;

/**
 * Prefix an on-host command so it runs in an AWS runtime user's systemd
 * session. Validate here as well as in the fleet schema because this public
 * command builder may also be called directly by integrations.
 */
export function buildAwsRuntimeUserCommand(runtimeUser: string, command: string): string {
  if (!AWS_RUNTIME_USER_PATTERN.test(runtimeUser)) {
    throw new Error(`Invalid AWS runtime user: ${runtimeUser}`);
  }
  const runtimeDir = `/run/user/$(id -u ${runtimeUser})`;
  return `sudo -H -u ${runtimeUser} env XDG_RUNTIME_DIR=${runtimeDir} DBUS_SESSION_BUS_ADDRESS=unix:path=${runtimeDir}/bus ${AWS_RUNTIME_SELECTION} ${command}`;
}
