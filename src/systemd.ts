import os from "node:os";
import { execFileSync } from "node:child_process";
import { buildPaths } from "./paths.js";
import { RuntimePaths } from "./types.js";

// Linux counterpart of the macOS launchd agent: a systemd user service (oneshot
// `daemon --once`) driven by a user timer firing every 300s, mirroring the
// launchd StartInterval=300 cadence. Units live in ~/.config/systemd/user so
// no root access is ever needed.

export const SYSTEMD_SERVICE_NAME = "coding-usage-bar.service";
export const SYSTEMD_TIMER_NAME = "coding-usage-bar.timer";

function unitEscape(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', "\\\"")
    .replaceAll("'", "\\'")
    .replaceAll("\n", "\\n");
}

// systemd resolves the first ExecStart token as an absolute executable path;
// pin the same stable node the CLI shim uses so unit upgrades never drift.
export function systemdServiceUnit(programArgs: string[], homeDir = os.homedir()) {
  const execStart = programArgs.map((arg) => `"${unitEscape(arg)}"`).join(" ");
  // User units inherit almost no PATH; notify-send lives in /usr/bin but a
  // user-installed node often lives in ~/.local/bin, so pin both like the
  // launchd plist pins Homebrew's bin directory on macOS.
  const daemonPath = [
    `${homeDir}/.local/bin`,
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  return `[Unit]
Description=Coding Usage Bar usage daemon (coding-usage-bar daemon --once)

[Service]
Type=oneshot
ExecStart=${execStart} "daemon" "--once"
Environment="PATH=${daemonPath}"
StandardOutput=append:${homeDir}/.coding-usage-bar/daemon.log
StandardError=append:${homeDir}/.coding-usage-bar/daemon.err.log
`;
}

export function systemdTimerUnit() {
  return `[Unit]
Description=Coding Usage Bar usage daemon timer

[Timer]
OnBootSec=60
OnUnitActiveSec=300
Unit=${SYSTEMD_SERVICE_NAME}

[Install]
WantedBy=default.target
`;
}

export type SystemctlRunner = (args: string[], options?: { stdio?: "ignore" }) => unknown;

function defaultRunner(args: string[], options?: { stdio?: "ignore" }) {
  return execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", ...options });
}

// execFileSync prefixes "Command failed: <cmd>" and appends child stderr to
// Error.message; surface only the stderr line so WARN output stays one line.
function errorText(error: unknown) {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  if (typeof stderr === "string" && stderr.trim()) {
    return stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

// Best-effort by design: the user manager is not running in every context
// (SSH without lingering, a fresh headless install), and a failed enable must
// not abort the install -- doctor reports the timer state and the message
// below names the exact command to finish the job.
export function restartSystemdUnits(
  paths: RuntimePaths = buildPaths(),
  run: SystemctlRunner = defaultRunner,
): string[] {
  const messages: string[] = [];
  try {
    run(["daemon-reload"]);
  } catch (error) {
    messages.push(`WARN systemctl --user daemon-reload failed: ${errorText(error)}`);
  }
  try {
    run(["enable", "--now", SYSTEMD_TIMER_NAME]);
    messages.push(`Installed and restarted systemd user timer: ${paths.systemdTimerFile}`);
  } catch (error) {
    messages.push(`WARN could not enable systemd user timer: ${errorText(error)}`);
    messages.push(`WARN run after your desktop session starts: systemctl --user enable --now ${SYSTEMD_TIMER_NAME}`);
    return messages;
  }
  try {
    run(["start", "--no-block", SYSTEMD_SERVICE_NAME]);
  } catch (error) {
    messages.push(`WARN could not start ${SYSTEMD_SERVICE_NAME}: ${errorText(error)}`);
  }
  return messages;
}

// Stop and disable whatever this install managed. Absent units and a missing
// user manager are both fine: uninstall must be repeatable on any state.
export function stopSystemdUnits(run: SystemctlRunner = defaultRunner): string[] {
  const messages: string[] = [];
  try {
    run(["disable", "--now", SYSTEMD_TIMER_NAME], { stdio: "ignore" });
    messages.push(`Disabled systemd user timer: ${SYSTEMD_TIMER_NAME}`);
  } catch {
    // Not enabled or user manager unavailable; the unit files are removed next.
  }
  try {
    run(["daemon-reload"], { stdio: "ignore" });
  } catch {
    // Best effort; stale unit references disappear on the next real session.
  }
  return messages;
}

// null when the user manager cannot be queried (headless SSH without a
// session bus); callers must degrade to "unknown" rather than "broken".
export function isSystemdTimerEnabled(run: SystemctlRunner = defaultRunner): boolean | null {
  try {
    const result = run(["is-enabled", SYSTEMD_TIMER_NAME]);
    return String(result ?? "").trim() === "enabled";
  } catch {
    return null;
  }
}
