#!/usr/bin/env node
import { usageFromClaudeStatusLine, readStdin } from "./claude.js";
import { install, uninstall } from "./install.js";
import { saveUsage } from "./store.js";
import { formatStatusRows, formatAnalysisDetail, formatIssues, formatProviderMeta, formatDiskStatus } from "./format.js";
import { formatCodexResetStatusLine } from "./codex-resets.js";
import { loadDisplayStatusSnapshot, collectStatusSnapshot } from "./runtime.js";
import { runDaemonOnce } from "./daemon.js";
import { doctorHasFailures, formatDoctor, runDoctor, runDoctorFix } from "./doctor.js";
import { installMenuBar, renderMenuBar, uninstallMenuBar, cycleTitleMode } from "./menubar.js";
import { installLinuxMenuBar, renderLinuxMenuBar, uninstallLinuxMenuBar } from "./menubar-linux.js";
import { buildPaths } from "./paths.js";
import { bakeGlyphAtlases } from "./glyphs.js";
import { maybePromptForStar } from "./star.js";
import { updateStatusSnapshotUsage } from "./status.js";

function hasFlag(args: string[], flag: string) {
  return args.includes(flag);
}

function printHelp() {
  console.log(`Coding Usage Bar

Usage:
  coding-usage-bar install [--dry-run]
  coding-usage-bar uninstall [--dry-run]
  coding-usage-bar doctor [--dry-run] [--fix]
  coding-usage-bar status [--fixtures] [--json] [--refresh]
  coding-usage-bar menubar render
  coding-usage-bar menubar install [--dry-run]
  coding-usage-bar menubar uninstall [--dry-run]
  coding-usage-bar menubar cycle-title-mode
  coding-usage-bar menubar bake-glyphs [--dry-run]
  coding-usage-bar ingest claude-statusline
  coding-usage-bar daemon [--once] [--dry-run]
`);
}

function isLinux() {
  return process.platform === "linux";
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const subcommand = args[1];
  const dryRun = hasFlag(args, "--dry-run");

  try {
    if (!command || command === "-h" || command === "--help") {
      printHelp();
      return;
    }

    if (command === "install") {
      const messages = install({ dryRun });
      console.log(messages.join("\n"));
      if (messages.some((message) => message.startsWith("Installed and restarted launchd agent:") || message.startsWith("Installed and restarted systemd user timer:"))) {
        const starMessages = maybePromptForStar(buildPaths(), { dryRun, env: process.env });
        if (starMessages.length > 0) {
          console.log(starMessages.join("\n"));
        }
      }
      return;
    }

    if (command === "uninstall") {
      console.log(uninstall({ dryRun }).join("\n"));
      return;
    }

    if (command === "doctor") {
      const fix = hasFlag(args, "--fix");
      if (fix) {
        const fixes = await runDoctorFix({ dryRun });
        if (fixes.length > 0) {
          console.log(fixes.join("\n"));
          console.log("");
        }
      }
      const checks = runDoctor({ dryRun });
      console.log(formatDoctor(checks));
      if (doctorHasFailures(checks)) {
        if (!fix) {
          console.log("");
          console.log("Run coding-usage-bar doctor --fix to repair common issues automatically.");
        }
        process.exitCode = 1;
      }
      return;
    }

    if (command === "status") {
      const fixtures = hasFlag(args, "--fixtures");
      const json = hasFlag(args, "--json");
      const refresh = hasFlag(args, "--refresh");
      const snapshot = refresh || fixtures
        ? await collectStatusSnapshot({ fixtures })
        : loadDisplayStatusSnapshot();
      if (json) {
        console.log(JSON.stringify(snapshot, null, 2));
        return;
      }
      const usages = snapshot.providers.map((provider) => provider.usage);
      const analyses = snapshot.providers.map((provider) => provider.analysis);
      console.log(formatStatusRows(usages, analyses));
      const disk = formatDiskStatus(snapshot.disk);
      if (disk) {
        console.log(disk);
      }
      const resetLine = formatCodexResetStatusLine(snapshot.codexReset);
      if (resetLine) {
        console.log(resetLine);
      }
      console.log("");
      for (const analysis of analyses) {
        console.log(formatAnalysisDetail(analysis));
      }
      const meta = formatProviderMeta(snapshot);
      if (meta) {
        console.log("");
        console.log(meta);
      }
      const issues = formatIssues(snapshot.issues);
      if (issues) {
        console.log("");
        console.log(issues);
      }
      return;
    }

    if (command === "menubar" && subcommand === "render") {
      console.log(isLinux() ? renderLinuxMenuBar() : renderMenuBar());
      return;
    }

    if (command === "menubar" && subcommand === "install") {
      console.log((isLinux() ? installLinuxMenuBar({ dryRun }) : installMenuBar({ dryRun })).join("\n"));
      return;
    }

    if (command === "menubar" && subcommand === "uninstall") {
      console.log((isLinux() ? uninstallLinuxMenuBar({ dryRun }) : uninstallMenuBar({ dryRun })).join("\n"));
      return;
    }

    // `toggle-compact` is the pre-tier name for this action. A dropdown that
    // SwiftBar rendered before the upgrade still carries it, so a click on
    // that stale menu must keep working instead of erroring out.
    if (command === "menubar" && (subcommand === "cycle-title-mode" || subcommand === "toggle-compact")) {
      console.log(cycleTitleMode());
      return;
    }

    if (command === "menubar" && subcommand === "bake-glyphs") {
      if (isLinux()) {
        console.log("Glyph atlases only feed the macOS SwiftBar menu bar; the Linux Argos menu renders text and needs no baking.");
        return;
      }
      console.log(bakeGlyphAtlases(buildPaths(), { dryRun }).join("\n"));
      return;
    }

    if (command === "ingest" && subcommand === "claude-statusline") {
      const input = await readStdin();
      const parsed = JSON.parse(input);
      const usage = usageFromClaudeStatusLine(parsed);
      saveUsage(usage);
      try {
        updateStatusSnapshotUsage(usage);
      } catch {
        // The provider cache is authoritative. A later daemon run can rebuild
        // status.json if this best-effort display update loses lock contention.
      }
      return;
    }

    if (command === "daemon") {
      console.log((await runDaemonOnce({ dryRun })).join("\n"));
      return;
    }

    throw new Error(`Unknown command: ${args.join(" ")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await main();
