import test from "node:test";
import assert from "node:assert/strict";
import {
  isSystemdTimerEnabled,
  restartSystemdUnits,
  stopSystemdUnits,
  systemdServiceUnit,
  systemdTimerUnit,
  SYSTEMD_SERVICE_NAME,
  SYSTEMD_TIMER_NAME,
} from "../dist/systemd.js";
import { buildPaths } from "../dist/paths.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("systemd service unit pins ExecStart, PATH, and log targets", () => {
  const unit = systemdServiceUnit(["/usr/bin/node", "/home/u/.coding-usage-bar/app/dist/cli.js"], "/home/u");
  assert.match(unit, /Type=oneshot/);
  assert.match(unit, /ExecStart="\/usr\/bin\/node" "\/home\/u\/.coding-usage-bar\/app\/dist\/cli\.js" "daemon" "--once"/);
  assert.match(unit, /Environment="PATH=\/home\/u\/.local\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"/);
  assert.match(unit, /StandardOutput=append:\/home\/u\/.coding-usage-bar\/daemon\.log/);
  assert.match(unit, /StandardError=append:\/home\/u\/.coding-usage-bar\/daemon\.err\.log/);
});

test("systemd service unit escapes quotes in arguments", () => {
  const unit = systemdServiceUnit(["/opt/node", "/tmp/cli's.js"], "/home/u");
  assert.match(unit, /ExecStart="\/opt\/node" "\/tmp\/cli\\'s\.js"/);
});

test("systemd timer unit fires 300s after the last activation", () => {
  const unit = systemdTimerUnit();
  assert.match(unit, /OnBootSec=60/);
  assert.match(unit, /OnUnitActiveSec=300/);
  assert.match(unit, new RegExp(`Unit=${SYSTEMD_SERVICE_NAME}`));
  assert.match(unit, /WantedBy=default\.target/);
});

test("restartSystemdUnits reloads, enables the timer, and kicks the service", () => {
  const calls = [];
  const messages = restartSystemdPathsWith((args) => {
    calls.push(args);
  });
  assert.deepEqual(calls, [["daemon-reload"], ["enable", "--now", SYSTEMD_TIMER_NAME], ["start", "--no-block", SYSTEMD_SERVICE_NAME]]);
  assert.ok(messages.some((message) => message.startsWith("Installed and restarted systemd user timer:")));
});

function restartSystemdPathsWith(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-systemd-"));
  return restartSystemdUnits(buildPaths(home), run);
}

test("restartSystemdUnits warns instead of failing when the user manager is unavailable", () => {
  const calls = [];
  const messages = restartSystemdPathsWith((args) => {
    calls.push(args);
    throw new Error("Failed to connect to bus: No medium found");
  });
  assert.deepEqual(calls, [["daemon-reload"], ["enable", "--now", SYSTEMD_TIMER_NAME]]);
  assert.ok(messages.some((message) => message.startsWith("WARN could not enable systemd user timer")));
  assert.ok(messages.some((message) => message.includes("systemctl --user enable --now")));
});

test("stopSystemdUnits disables the timer and reloads, tolerating an absent user manager", () => {
  const calls = [];
  stopSystemdUnits((args) => {
    calls.push(args);
    if (args[0] === "disable") {
      throw new Error("unit not loaded");
    }
  });
  assert.deepEqual(calls, [["disable", "--now", SYSTEMD_TIMER_NAME], ["daemon-reload"]]);
});

test("isSystemdTimerEnabled reports enabled, disabled, and unknown", () => {
  assert.equal(isSystemdTimerEnabled(() => "enabled\n"), true);
  assert.equal(isSystemdTimerEnabled(() => "disabled\n"), false);
  assert.equal(isSystemdTimerEnabled(() => {
    throw new Error("no bus");
  }), null);
});
