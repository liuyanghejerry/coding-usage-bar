import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ensureDir, isFile } from "./fs-util.js";
import { DISK_ALERT_USED_PERCENT, DISK_WARNING_USED_PERCENT } from "./disk.js";
import {
  CODEX_RESETS_CREDIT_LABEL,
  CODEX_RESETS_CREDIT_URL,
  codexResetSummary,
} from "./codex-resets.js";
import { formatBytes, formatProviderLabel, formatResetTime } from "./format.js";
import { buildPaths } from "./paths.js";
import { stableNodeExecutable } from "./node-runtime.js";
import { loadDisplayStatusSnapshot } from "./runtime.js";
import {
  mostUrgentProvider,
  readTitleMode,
  STATE_LABEL,
  titleProviders,
  titleSegment,
} from "./menubar.js";
import { BurnState, CodexResetStatus, DiskUsage, RuntimePaths, StatusSnapshot } from "./types.js";

// Argos (GNOME Shell) counterpart of the SwiftBar menu bar on macOS. Same
// producer/display split: this module only reads status.json (via
// loadDisplayStatusSnapshot) and prints Argos/BitBar-format lines; Argos turns
// them into a panel button plus dropdown menu. Argos is a thin host like
// SwiftBar -- collection state lives in status.json, never here.

const MARKER = "coding-usage-bar managed Argos plugin";
export const ARGOS_EXTENSION_ID = "argos@pew.worldwidemann.com";
const ARGOS_USER_EXTENSION_DIR = path.join(
  process.env.HOME ?? "",
  ".local",
  "share",
  "gnome-shell",
  "extensions",
  ARGOS_EXTENSION_ID,
);
const ARGOS_SYSTEM_EXTENSION_DIRS = [
  "/usr/share/gnome-shell/extensions",
  "/usr/local/share/gnome-shell/extensions",
];

const TITLE_SEPARATOR = "│";
const METER_WIDTH = 8;

// Japanese traditional accents: Akacha, Yamabukicha, Matsuba, Ginnezu.
const ALERT_COLOR = "#BB5535";
const WARNING_COLOR = "#C89932";
const OK_COLOR = "#687E52";
const RAW_COLOR = OK_COLOR;

const STATE_COLOR: Record<BurnState, string> = {
  RAW: RAW_COLOR,
  UNDER_BURN: WARNING_COLOR,
  ON_TRACK: OK_COLOR,
  OVER_BURN: ALERT_COLOR,
  LIMIT_RISK: ALERT_COLOR,
};

// Body text follows the GNOME Shell theme automatically: rows below omit an
// explicit text color so Argos uses the theme's foreground on whatever menu
// background the shell draws (dark or light). Only accents carry fixed colors.
const MUTED_COLOR = "#AFAFB0";
const ROW_FONT = "Monospace";

// Argos interprets Pango markup in line text by default;
// generated meters use trusted spans, and free-text rows (issue messages, upstream
// reset announcements) disable markup so `<`/`&` in the text cannot break the
// menu rendering.
function argosEscape(value: string) {
  return value.replaceAll("|", "\\|");
}

function argosParamValue(value: string | number | boolean) {
  return String(value).replaceAll(" ", "\\ ");
}

function line(title: string, params: Record<string, string | number | boolean | undefined> = {}) {
  const styledParams: Record<string, string | number | boolean | undefined> = { size: 10, ...params };
  const renderedParams = Object.entries(styledParams)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${argosParamValue(value)}`);
  if (renderedParams.length === 0) {
    return argosEscape(title);
  }
  return `${argosEscape(title)} | ${renderedParams.join(" ")}`;
}

function muted(text: string) {
  return line(text, { size: 10, length: 52, useMarkup: false });
}

// Argos only parses the eight basic ANSI colors. Pango spans preserve exact
// RGB accents without interpreting RGB components as unrelated ANSI commands.
function colorSpan(hex: string, text: string) {
  return `<span foreground="${hex}">${text}</span>`;
}

function coloredMeter(usedPercent: number, fillColor: string, width = METER_WIDTH) {
  const filled = Math.max(0, Math.min(width, Math.round((usedPercent / 100) * width)));
  const empty = width - filled;
  return (filled > 0 ? colorSpan(fillColor, "█".repeat(filled)) : "")
    + (empty > 0 ? colorSpan(MUTED_COLOR, "░".repeat(empty)) : "");
}

function usageLine(label: "5h" | "7d", usedPercent: number, resetsAt: string, color: string, now: Date) {
  const percent = `${Math.round(usedPercent).toString().padStart(3)}%`;
  const bar = coloredMeter(usedPercent, color);
  return line(`${label}  ${bar}  ${colorSpan(color, percent)}  reset ${formatResetTime(resetsAt, now)}`, {
    ansi: false,
    useMarkup: true,
    font: ROW_FONT,
    size: 10,
  });
}

function windowByName(provider: StatusSnapshot["providers"][number], name: "five_hour" | "seven_day") {
  return provider.usage.windows.find((window) => window.name === name);
}

function targetLabel(provider: StatusSnapshot["providers"][number]) {
  const target = provider.analysis.target;
  if (!target) {
    return "Target learning baseline";
  }
  return `Target ${target.minPercent.toFixed(1)}-${target.maxPercent.toFixed(1)}%`;
}

function issueLabel(code: string) {
  if (code === "CLAUDE_INGEST_MISSING") {
    return "Claude not connected";
  }
  if (code === "GLM_API_KEY_MISSING") {
    return "GLM API key not set";
  }
  if (code === "DEEPSEEK_API_KEY_MISSING") {
    return "DeepSeek API key not set";
  }
  if (code === "MINIMAX_API_KEY_MISSING") {
    return "MiniMax API key not set";
  }
  if (code === "KIMI_API_KEY_MISSING") {
    return "Kimi API key not set";
  }
  if (code === "USAGE_STALE") {
    return "Usage data is stale";
  }
  if (code === "STATUS_MISSING") {
    return "Status not ready";
  }
  return code.replaceAll("_", " ").toLowerCase();
}

function diskStateLabel(usedPercent: number) {
  if (usedPercent >= DISK_ALERT_USED_PERCENT) {
    return "Critical";
  }
  if (usedPercent >= DISK_WARNING_USED_PERCENT) {
    return "Low";
  }
  return "OK";
}

function diskLowMessage() {
  return "Low disk space — clean up caches, node_modules, and Docker images.";
}

function appCliPath(paths: RuntimePaths) {
  return path.join(paths.stateDir, "app", "dist", "cli.js");
}

// The macOS tier ladder exists because an over-wide item is pushed under the
// notch and disappears; GNOME just shares the panel width, and Argos menus
// ellipsize, so `auto` always renders the full title. The manual
// Full/Single/Icon override (compact-mode file) is honored the same way.
type TitleTier = "full" | "single" | "icon";

const TITLE_TIER_LABEL: Record<TitleTier, string> = {
  full: "Full",
  single: "Single",
  icon: "Icon",
};

function titleModeLabel(mode: "auto" | TitleTier, tier: TitleTier) {
  return mode === "auto"
    ? `Title  Auto (${TITLE_TIER_LABEL[tier]})`
    : `Title  ${TITLE_TIER_LABEL[mode]}`;
}

// `now` only feeds low-frequency labels (reset due). Output must stay
// byte-identical across renders while the snapshot is unchanged so Argos can
// skip re-renders; never emit wall-clock countdowns.
export function renderLinuxMenuBar(
  snapshot: StatusSnapshot = loadDisplayStatusSnapshot(),
  paths: RuntimePaths = buildPaths(),
  now: Date = new Date(),
) {
  const mode = readTitleMode(paths);
  const providers = titleProviders(snapshot);
  const tier: TitleTier = mode === "auto" ? "full" : mode;

  const modeLine = line(titleModeLabel(mode, tier), {
    bash: stableNodeExecutable(),
    param1: appCliPath(paths),
    param2: "menubar",
    param3: "cycle-title-mode",
    terminal: false,
    refresh: true,
  });

  if (providers.length === 0) {
    return [
      line("🔥 Coding Usage Bar  No Usage", { dropdown: false }),
      "---",
      line("No provider usage available", { color: MUTED_COLOR }),
      modeLine,
      line("Refresh now", { refresh: true }),
    ].join("\n");
  }

  const shown = tier === "single" ? [mostUrgentProvider(providers)] : providers;
  const title = shown
    .map((provider) => `${formatProviderLabel(provider.usage.provider)} ${titleSegment(provider)}`)
    .join(` ${TITLE_SEPARATOR} `);

  const header = tier === "icon"
    ? line("🔥", { dropdown: false })
    : line(title + codexResetTitleSuffix(snapshot.codexReset, now), { dropdown: false });

  const lines = [header, "---"];
  const details: string[] = [];
  lines.push(line(`Coding Usage Bar · ${snapshot.profile.toUpperCase()} · ${snapshot.providers.some((item) => item.meta.stale) ? "Stale" : "Fresh"}`, { size: 10 }));
  lines.push("---");

  for (const item of providers) {
    const five = windowByName(item, "five_hour");
    const seven = windowByName(item, "seven_day");
    const stateColor = item.usage.blocked
      ? MUTED_COLOR
      : item.usage.balance && item.usage.windows.length === 0
        ? (item.usage.balance.isAvailable ? OK_COLOR : ALERT_COLOR)
        : STATE_COLOR[item.analysis.state];

    if (item.usage.balance && item.usage.windows.length === 0) {
      const currency = item.usage.balance.currency === "CNY" ? "¥" : "$";
      const balanceText = `${currency}${item.usage.balance.total}`;
      lines.push(line(
        `${formatProviderLabel(item.usage.provider)}  ${item.usage.balance.isAvailable ? "Available" : "Depleted"}  ${balanceText}`,
        { size: 11 },
      ));
      details.push(muted(`${formatProviderLabel(item.usage.provider)}: ${item.analysis.message}`));
      lines.push("---");
      continue;
    }

    lines.push(line(`${formatProviderLabel(item.usage.provider)}  ${item.usage.blocked ? "Blocked / Frozen" : STATE_LABEL[item.analysis.state]}`, {
      size: 11,
    }));
    if (five) {
      lines.push(usageLine("5h", five.usedPercent, five.resetsAt, stateColor, now));
    }
    if (seven) {
      lines.push(usageLine("7d", seven.usedPercent, seven.resetsAt, stateColor, now));
    }
    if (item.usage.blocked) {
      lines.push(muted(`Blocked: ${item.usage.blocked.reason}`));
    }
    if (item.usage.provider === "codex") {
      const resetSummary = codexResetSummary(snapshot.codexReset, now);
      if (resetSummary) {
        details.push(muted(`Tibo Reset  ${resetSummary}`));
      }
    }
    details.push(muted(`${formatProviderLabel(item.usage.provider)} · ${targetLabel(item)}`));
    details.push(muted(`${formatProviderLabel(item.usage.provider)}: ${item.analysis.message}`));
    lines.push("---");
  }

  if (snapshot.disk) {
    const disk: DiskUsage = snapshot.disk;
    lines.push(line(`Disk  ${Math.round(disk.usedPercent)}% · ${formatBytes(disk.availableBytes)} free · ${diskStateLabel(disk.usedPercent)}`, {
      size: 11,
    }));
    if (disk.usedPercent >= DISK_ALERT_USED_PERCENT) {
      lines.push(muted(diskLowMessage()));
    }
    lines.push("---");
  }

  for (const issue of snapshot.issues) {
    const color = issue.severity === "error" ? ALERT_COLOR : WARNING_COLOR;
    lines.push(line(`${issue.severity.toUpperCase()}  ${issueLabel(issue.code)}`, {
      color,
      size: 10,
    }));
    lines.push(line(issue.message, { color: MUTED_COLOR, size: 10, length: 52, useMarkup: false }));
  }
  if (snapshot.issues.length > 0) {
    lines.push("---");
  }

  if (details.length > 0) {
    lines.push(line("Details"));
    lines.push(...details.map((entry) => `--${entry}`));
  }

  // The reset tracker asks for a visible credit link wherever its data is
  // displayed; keep this text row even in the Argos menu.
  if (snapshot.codexReset) {
    lines.push(line(CODEX_RESETS_CREDIT_LABEL, {
      href: CODEX_RESETS_CREDIT_URL,
      color: MUTED_COLOR,
      size: 10,
    }));
  }
  lines.push(modeLine);
  lines.push(line("Refresh now", { refresh: true }));
  lines.push(line("Exit Coding Usage Bar", {
    bash: stableNodeExecutable(),
    param1: appCliPath(buildPaths()),
    param2: "menubar",
    param3: "uninstall",
    terminal: false,
    color: MUTED_COLOR,
  }));
  return lines.join("\n");
}

// --- Argos host management ---

// Test isolation escape hatch, same contract as the SwiftBar side: tests point
// this at a temp dir so install/uninstall can never touch a real ~/.config/argos.
function configuredArgosPluginDir(paths: RuntimePaths) {
  const override = process.env.CODING_USAGE_BAR_PLUGIN_DIR?.trim();
  return override || paths.argosPluginDir;
}

export function argosPluginPath(paths: RuntimePaths = buildPaths()) {
  const pluginDir = configuredArgosPluginDir(paths);
  return {
    dir: pluginDir,
    file: path.join(pluginDir, "coding-usage-bar.1m.js"),
  };
}

function listGnomeExtensions(activeOnly = false): string[] {
  try {
    const output = execFileSync("gnome-extensions", activeOnly ? ["list", "--active"] : ["list"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split("\n").map((entry) => entry.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function isArgosInstalled() {
  if (listGnomeExtensions().includes(ARGOS_EXTENSION_ID)) {
    return true;
  }
  return [ARGOS_USER_EXTENSION_DIR, ...ARGOS_SYSTEM_EXTENSION_DIRS.map((dir) => path.join(dir, ARGOS_EXTENSION_ID))]
    .some((dir) => fs.existsSync(dir));
}

export function isArgosEnabled() {
  // An installed (or enabled but failed) extension cannot host a panel button.
  return listGnomeExtensions(true).includes(ARGOS_EXTENSION_ID);
}

// Argos cannot be installed non-interactively on modern GNOME (no EGO listing;
// installing from git needs a Shell restart), so the installer verifies and
// instructs instead of silently doing nothing.
export function ensureArgosInstalled(options: { dryRun?: boolean } = {}) {
  const dryRun = options.dryRun ?? false;
  if (dryRun) {
    return ["[dry-run] would verify the Argos GNOME Shell extension is installed and enabled"];
  }
  if (isArgosEnabled()) {
    return ["Argos extension already installed and enabled."];
  }
  if (isArgosInstalled()) {
    try {
      execFileSync("gnome-extensions", ["enable", ARGOS_EXTENSION_ID], { stdio: "ignore" });
    } catch {
      // GNOME Shell restarts or a Wayland re-login pick the change up later.
    }
    if (isArgosEnabled()) {
      return ["Enabled the Argos GNOME Shell extension."];
    }
    return [
      "Argos is installed but not enabled. Enable it with:",
      `  gnome-extensions enable ${ARGOS_EXTENSION_ID}`,
      "or from the GNOME Extensions app, then re-run: coding-usage-bar doctor --fix",
    ];
  }
  return [
    "Argos GNOME Shell extension not found. Install it, then re-run: coding-usage-bar install",
    "  git clone https://github.com/p-e-w/argos ~/.local/share/gnome-shell/extensions/" + ARGOS_EXTENSION_ID,
    "  # then log out/in (Wayland) or restart GNOME Shell, and enable it:",
    `  gnome-extensions enable ${ARGOS_EXTENSION_ID}`,
  ];
}

export interface LinuxPluginRunResult {
  ok: boolean;
  output: string;
}

// Execute the installed plugin exactly the way Argos would and check it
// produces a real menu. Mirrors the SwiftBar-side verification.
function runPluginScript(file: string): LinuxPluginRunResult {
  try {
    const stdout = execFileSync(file, { encoding: "utf8", timeout: 30000 });
    const output = stdout.trim();
    return { ok: output.length > 0 && !output.startsWith("Usage ERR"), output };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

const MENU_BAR_MANUAL_STEPS = [
  "Menu bar is NOT ready yet. Fix it with these steps:",
  "  1. Install the Argos GNOME Shell extension: https://github.com/p-e-w/argos",
  `  2. Enable it: gnome-extensions enable ${ARGOS_EXTENSION_ID}`,
  "  3. Log out and back in if the Argos button still does not appear (Wayland cannot restart GNOME Shell).",
  "  4. Re-run: coding-usage-bar doctor --fix",
];

export interface VerifyLinuxMenuBarOptions {
  dryRun?: boolean;
  argosInstalled?: () => boolean;
  argosEnabled?: () => boolean;
  runPlugin?: (file: string) => LinuxPluginRunResult;
  repairPlugin?: () => string[];
  ensureArgos?: () => string[];
}

// End-to-end acceptance at the end of install: the Argos extension is present
// and the plugin renders a real menu when executed the way Argos executes it.
export function verifyLinuxMenuBarSetup(options: VerifyLinuxMenuBarOptions = {}) {
  if (options.dryRun) {
    return ["[dry-run] would verify the Argos plugin renders and the panel button appears"];
  }
  const paths = buildPaths();
  const plugin = argosPluginPath(paths);
  const installed = options.argosInstalled ?? isArgosInstalled;
  const enabled = options.argosEnabled ?? isArgosEnabled;
  const messages: string[] = [];

  if (!installed()) {
    return [
      ...MENU_BAR_MANUAL_STEPS,
      "  (Argos is not installed; see step 1.)",
    ];
  }

  if (!isFile(plugin.file)) {
    messages.push(...(options.repairPlugin ?? installLinuxMenuBar)());
  }

  if (!enabled()) {
    messages.push(...(options.ensureArgos ?? ensureArgosInstalled)());
    if (!enabled()) {
      return [...messages, ...MENU_BAR_MANUAL_STEPS, "  (Argos is not active.)"];
    }
  }

  if (!isFile(plugin.file)) {
    return [...messages, ...MENU_BAR_MANUAL_STEPS, `  (Plugin file missing: ${plugin.file})`];
  }

  const run = (options.runPlugin ?? runPluginScript)(plugin.file);
  if (!run.ok) {
    return [...messages, ...MENU_BAR_MANUAL_STEPS, `  (Plugin output: ${run.output})`];
  }

  messages.push("");
  messages.push("Menu bar ready — Coding Usage Bar should now appear in your GNOME top bar.");
  return messages;
}

function linuxPluginScript(paths: RuntimePaths) {
  const node = stableNodeExecutable();
  return `#!${node}
// ${MARKER}
const { spawnSync } = require("node:child_process");
const result = spawnSync(${JSON.stringify(node)}, [${JSON.stringify(appCliPath(paths))}, "menubar", "render"], {
  encoding: "utf8",
});
if (result.error) {
  console.log("Usage ERR");
  console.log("---");
  console.log(result.error.message);
  process.exit(0);
}
if (result.status !== 0) {
  console.log("Usage ERR");
  console.log("---");
  console.log(result.stderr || result.stdout || "coding-usage-bar menubar render failed");
  process.exit(0);
}
process.stdout.write(result.stdout);
`;
}

function isManagedLinuxPlugin(paths: RuntimePaths) {
  const plugin = argosPluginPath(paths);
  try {
    return fs.readFileSync(plugin.file, "utf8").includes(MARKER);
  } catch {
    return false;
  }
}

export function installLinuxMenuBar(options: { dryRun?: boolean } = {}) {
  const dryRun = options.dryRun ?? false;
  const paths = buildPaths();
  const plugin = argosPluginPath(paths);
  if (dryRun) {
    return [`[dry-run] would write Argos plugin: ${plugin.file}`];
  }
  if (isFile(plugin.file) && !isManagedLinuxPlugin(paths)) {
    return [`Argos plugin already exists and is not managed by coding-usage-bar: ${plugin.file}`];
  }
  ensureDir(plugin.dir);
  fs.writeFileSync(plugin.file, linuxPluginScript(paths), { mode: 0o755 });
  return [
    `Installed Argos plugin: ${plugin.file}`,
    "Argos watches ~/.config/argos automatically; the panel button appears within about a minute.",
  ];
}

export function uninstallLinuxMenuBar(options: { dryRun?: boolean } = {}) {
  const dryRun = options.dryRun ?? false;
  const paths = buildPaths();
  const plugin = argosPluginPath(paths);
  if (!isFile(plugin.file)) {
    return ["No Coding Usage Bar Argos plugin installed."];
  }
  if (!isManagedLinuxPlugin(paths)) {
    return [`Argos plugin is user-managed; leaving it unchanged: ${plugin.file}`];
  }
  if (dryRun) {
    return [`[dry-run] would remove Argos plugin: ${plugin.file}`];
  }
  fs.rmSync(plugin.file, { force: true });
  return [`Removed Argos plugin: ${plugin.file}`];
}

// Codex reset mark for the title line: while a reset is scheduled (or a watch
// is active) the header gains a red/amber dot after the Codex segment. Kept
// text-only because Argos colors whole lines, not spans.
export function codexResetTitleSuffix(codexReset: CodexResetStatus | null | undefined, now: Date) {
  const summary = codexResetSummary(codexReset, now);
  return summary ? `  ● ${summary}` : "";
}
