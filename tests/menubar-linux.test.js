import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  argosPluginPath,
  ensureArgosInstalled,
  installLinuxMenuBar,
  isArgosEnabled,
  isArgosInstalled,
  renderLinuxMenuBar,
  uninstallLinuxMenuBar,
  verifyLinuxMenuBarSetup,
} from "../dist/menubar-linux.js";
import { writeTitleMode } from "../dist/menubar.js";
import { buildPaths } from "../dist/paths.js";

function freshPaths() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-menubar-linux-"));
  return buildPaths(home);
}

const codexProvider = {
  usage: {
    provider: "codex",
    source: "test",
    observedAt: "2026-05-08T00:00:00.000Z",
    windows: [
      { name: "five_hour", windowMinutes: 300, usedPercent: 55, resetsAt: "2026-05-08T03:00:00.000Z" },
      { name: "seven_day", windowMinutes: 10080, usedPercent: 67, resetsAt: "2026-05-12T00:00:00.000Z" },
    ],
  },
  analysis: {
    provider: "codex",
    state: "OVER_BURN",
    profile: "low",
    observedAt: "2026-05-08T00:00:00.000Z",
    fiveHour: { name: "five_hour", windowMinutes: 300, usedPercent: 55, resetsAt: "2026-05-08T03:00:00.000Z" },
    sevenDay: { name: "seven_day", windowMinutes: 10080, usedPercent: 67, resetsAt: "2026-05-12T00:00:00.000Z" },
    message: "Codex 5h usage is above target.",
  },
  meta: { source: "test", observedAt: "2026-05-08T00:00:00.000Z", ageSeconds: 10, stale: false },
};

function snapshotWith(providers, extra = {}) {
  return {
    generatedAt: "2026-05-08T00:10:00.000Z",
    profile: "low",
    providers,
    issues: [],
    ...extra,
  };
}

test("renderLinuxMenuBar renders a text title with provider windows and traditional-color meters", () => {
  const paths = freshPaths();
  const snapshot = snapshotWith([codexProvider]);
  const now = new Date("2026-05-08T00:20:00.000Z");

  const output = renderLinuxMenuBar(snapshot, paths, now);
  const lines = output.split("\n");
  const title = lines[0];

  assert.match(title, /dropdown=false/);
  assert.match(title, /Codex 5H:55%,7D:67%/);
  assert.doesNotMatch(output, /sfimage/);
  assert.match(output, /<span foreground="#BB5535">/);
  assert.match(output, /<span foreground="#AFAFB0">/);
  assert.doesNotMatch(output, /\x1b\[/);
  assert.match(output, /ansi=false useMarkup=true/);
  assert.match(output, /5h\s+<span/);
  assert.match(output, /reset \d{2}:\d{2}/);
  assert.match(output, /Codex\s+Fast/);
  assert.match(output, /Tibo Reset|Data from codex-resets\.com|Title\s+Auto \(Full\)/);
  assert.match(output, /bash=.*cycle-title-mode/);
  assert.match(output, /Refresh now \| size=10 refresh=true/);
  assert.match(output, /param2=menubar param3=uninstall/);
});

test("renderLinuxMenuBar is byte-stable for an unchanged snapshot", () => {
  const paths = freshPaths();
  const snapshot = snapshotWith([codexProvider]);
  const now = new Date("2026-05-08T00:20:00.000Z");
  assert.equal(renderLinuxMenuBar(snapshot, paths, now), renderLinuxMenuBar(snapshot, paths, now));
});

test("renderLinuxMenuBar shows a placeholder menu without providers", () => {
  const paths = freshPaths();
  const output = renderLinuxMenuBar(snapshotWith([]), paths, new Date("2026-05-08T00:20:00.000Z"));
  assert.match(output, /No Usage/);
  assert.match(output, /No provider usage available/);
});

test("renderLinuxMenuBar renders disk and issue rows", () => {
  const paths = freshPaths();
  const snapshot = snapshotWith([codexProvider], {
    disk: {
      mountPoint: "/",
      totalBytes: 500e9,
      availableBytes: 40e9,
      usedPercent: 92,
      measuredAt: "2026-05-08T00:10:00.000Z",
    },
    issues: [
      { provider: "glm", severity: "warning", code: "GLM_API_KEY_MISSING", message: "GLM API key not configured." },
    ],
  });
  const output = renderLinuxMenuBar(snapshot, paths, new Date("2026-05-08T00:20:00.000Z"));
  assert.match(output, /Disk.*Critical/);
  assert.match(output, /Low disk space/);
  assert.match(output, /GLM API key not set/);
});

test("renderLinuxMenuBar honors the manual single and icon title tiers", () => {
  const paths = freshPaths();
  const snapshot = snapshotWith([codexProvider]);

  writeTitleMode("single", paths);
  const single = renderLinuxMenuBar(snapshot, paths, new Date("2026-05-08T00:20:00.000Z"));
  assert.match(single.split("\n")[0], /Codex 5H:55%,7D:67% \| size=10 dropdown=false/);

  writeTitleMode("icon", paths);
  const icon = renderLinuxMenuBar(snapshot, paths, new Date("2026-05-08T00:20:00.000Z"));
  assert.match(icon.split("\n")[0], /^🔥 \| size=10 dropdown=false/);
  writeTitleMode("auto", paths);
});

// --- Argos plugin management -------------------------------------------------

function withSandboxedPluginDir(home, fn) {
  const original = process.env.CODING_USAGE_BAR_PLUGIN_DIR;
  process.env.CODING_USAGE_BAR_PLUGIN_DIR = path.join(home, "argos-sandbox");
  try {
    fn(process.env.CODING_USAGE_BAR_PLUGIN_DIR);
  } finally {
    if (original === undefined) {
      delete process.env.CODING_USAGE_BAR_PLUGIN_DIR;
    } else {
      process.env.CODING_USAGE_BAR_PLUGIN_DIR = original;
    }
  }
}

test("installLinuxMenuBar writes a managed executable Argos plugin and uninstall removes it", () => {
  const paths = freshPaths();
  withSandboxedPluginDir(paths.homeDir, () => {
    const messages = installLinuxMenuBar();
    const plugin = argosPluginPath(paths);
    assert.ok(fs.existsSync(plugin.file));
    const stat = fs.statSync(plugin.file);
    assert.ok(stat.mode & 0o111, "plugin must be executable for Argos to run it");
    const content = fs.readFileSync(plugin.file, "utf8");
    assert.match(content, /coding-usage-bar managed Argos plugin/);
    assert.match(content, /menubar", "render/);
    assert.ok(messages.some((message) => message.includes("Installed Argos plugin")));

    const removed = uninstallLinuxMenuBar();
    assert.equal(fs.existsSync(plugin.file), false);
    assert.ok(removed.some((message) => message.includes("Removed Argos plugin")));
  });
});

test("installLinuxMenuBar refuses to overwrite a user-managed plugin", () => {
  const paths = freshPaths();
  withSandboxedPluginDir(paths.homeDir, (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "coding-usage-bar.1m.js"), "#!/bin/sh\necho mine\n");
    const messages = installLinuxMenuBar();
    assert.ok(messages.some((message) => message.includes("not managed by coding-usage-bar")));
    assert.equal(fs.readFileSync(path.join(dir, "coding-usage-bar.1m.js"), "utf8"), "#!/bin/sh\necho mine\n");
  });
});

test("uninstallLinuxMenuBar leaves a user-managed plugin unchanged", () => {
  const paths = freshPaths();
  withSandboxedPluginDir(paths.homeDir, (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "coding-usage-bar.1m.js"), "#!/bin/sh\necho mine\n");
    const messages = uninstallLinuxMenuBar();
    assert.ok(messages.some((message) => message.includes("user-managed")));
    assert.ok(fs.existsSync(path.join(dir, "coding-usage-bar.1m.js")));
  });
});

test("verifyLinuxMenuBarSetup reports ready when Argos is present and the plugin renders", () => {
  const messages = verifyLinuxMenuBarSetup({
    argosInstalled: () => true,
    argosEnabled: () => true,
    runPlugin: () => ({ ok: true, output: "title | dropdown=false" }),
    repairPlugin: () => ["Installed Argos plugin (test seam)."],
  });
  assert.ok(messages.some((message) => message.includes("Menu bar ready")));
});

test("verifyLinuxMenuBarSetup prints manual steps when Argos is missing", () => {
  const messages = verifyLinuxMenuBarSetup({
    argosInstalled: () => false,
    argosEnabled: () => false,
    runPlugin: () => ({ ok: false, output: "" }),
  });
  assert.ok(messages.some((message) => message.includes("Menu bar is NOT ready yet")));
  assert.ok(messages.some((message) => message.includes("p-e-w/argos")));
});

test("ensureArgosInstalled dry-run announces the check without touching the host", () => {
  const messages = ensureArgosInstalled({ dryRun: true });
  assert.equal(messages.length, 1);
  assert.match(messages[0], /\[dry-run\].*Argos/);
});

test("Argos presence does not imply an active extension", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-gnome-"));
  const originalPath = process.env.PATH;
  const cli = path.join(dir, "gnome-extensions");
  const writeCli = (active) => fs.writeFileSync(cli,
    `#!/bin/sh\nif [ "$2" != "--active" ] || [ "${active}" = "true" ]; then\n  echo argos@pew.worldwidemann.com\nfi\n`,
    { mode: 0o755 });
  process.env.PATH = dir;
  try {
    writeCli(false);
    assert.equal(isArgosInstalled(), true);
    assert.equal(isArgosEnabled(), false);
    writeCli(true);
    assert.equal(isArgosEnabled(), true);
    fs.writeFileSync(cli, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    assert.equal(isArgosEnabled(), false);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verification never reports ready if enabling Argos fails", () => {
  const paths = freshPaths();
  withSandboxedPluginDir(paths.homeDir, (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "coding-usage-bar.1m.js"), "test");
    const messages = verifyLinuxMenuBarSetup({
      argosInstalled: () => true,
      argosEnabled: () => false,
      ensureArgos: () => ["Enable failed"],
      runPlugin: () => { throw new Error("inactive host cannot be ready"); },
    });
    assert.ok(messages.some((message) => message.includes("NOT ready")));
    assert.ok(messages.some((message) => message.includes("not active")));
    assert.ok(!messages.some((message) => message.includes("Menu bar ready")));
  });
});
