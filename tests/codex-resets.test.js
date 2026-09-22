import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  CODEX_RESETS_STATUS_URL,
  codexResetCardNote,
  codexResetMarkLevel,
  codexResetSummary,
  fetchCodexResetStatus,
  formatCodexResetStatusLine,
  nextCodexResetNotice,
  normalizeCodexResetStatus,
} from "../dist/codex-resets.js";
import { formatResetTime } from "../dist/format.js";
import { markCodexResetSeen, readCodexResetSeen, runCodexResetNotifications } from "../dist/notifier.js";
import { buildPaths } from "../dist/paths.js";

const NOW = new Date("2026-05-08T00:00:00.000Z");

function apiPayload(overrides = {}) {
  return {
    data: {
      latest_reset: {
        id: "reset-1",
        reset_type: "regular",
        announced_at: "2026-05-07T18:00:00.000Z",
        text: "Reset all propagated. Sweet dreams.",
        source: { type: "x_post", author: "thsottiaux", url: "https://x.com/thsottiaux/status/reset-1" },
      },
      scheduled_reset: {
        id: "reset-2",
        status: "scheduled",
        reset_type: "regular",
        announced_at: "2026-05-07T22:31:32.000Z",
        scheduled_for: "2026-05-08T06:59:00.000Z",
        text: "I promised a reset for Friday. See you soon.",
        source: { type: "x_post", author: "thsottiaux", url: "https://x.com/thsottiaux/status/reset-2" },
      },
      active_watch: {
        level: "elevated",
        reset_chance_percent: 55,
        forecast_window: "next 24h",
        observed_at: "2026-05-07T20:00:00.000Z",
        expires_at: "2026-05-09T20:00:00.000Z",
        text: "Chatter points at a possible Friday reset.",
        source: { type: "observed", url: "https://codex-resets.com" },
      },
      stats: {
        total: 12,
        last_reset_at: "2026-05-07T18:00:00.000Z",
        days_since_last: 0.3,
        avg_interval_days: 6.9,
      },
      ...overrides,
    },
    meta: { api_version: "v1", generated_at: "2026-05-08T00:00:00.000Z" },
  };
}

function freshPaths() {
  return buildPaths(fs.mkdtempSync(path.join(os.tmpdir(), "coding-usage-bar-reset-")));
}

test("normalizeCodexResetStatus maps the API payload to the stored shape", () => {
  const status = normalizeCodexResetStatus(apiPayload(), NOW);
  assert.ok(status);
  assert.equal(status.latestReset?.id, "reset-1");
  assert.equal(status.latestReset?.scheduledFor, null);
  assert.equal(status.latestReset?.sourceAuthor, "thsottiaux");
  assert.equal(status.scheduledReset?.scheduledFor, "2026-05-08T06:59:00.000Z");
  assert.equal(status.activeWatch?.level, "elevated");
  assert.equal(status.activeWatch?.sourceAuthor, null, "observed sources carry no author");
  assert.equal(status.stats.avgIntervalDays, 6.9);
  assert.equal(status.observedAt, NOW.toISOString());
});

test("normalizeCodexResetStatus rejects unusable payloads", () => {
  assert.equal(normalizeCodexResetStatus(null, NOW), null);
  assert.equal(normalizeCodexResetStatus({ meta: {} }, NOW), null);
  assert.equal(normalizeCodexResetStatus({ data: {} }, NOW), null);
  // Dates that fail to parse are dropped rather than poisoning status.json.
  const status = normalizeCodexResetStatus({
    data: { latest_reset: { id: "x", announced_at: "not-a-date", text: "t" } },
  }, NOW);
  assert.equal(status, null);
});

test("fetchCodexResetStatus is null-safe end to end", async () => {
  const ok = await fetchCodexResetStatus({
    fetchImpl: async () => Response.json(apiPayload()),
  });
  assert.equal(ok?.scheduledReset?.id, "reset-2");

  const httpError = await fetchCodexResetStatus({
    fetchImpl: async () => new Response("boom", { status: 503 }),
  });
  assert.equal(httpError, null);

  const networkError = await fetchCodexResetStatus({
    fetchImpl: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(networkError, null);
  assert.equal(CODEX_RESETS_STATUS_URL, "https://codex-resets.com/api/v1/status");
});

test("mark level: scheduled reset is alert, watches grade by level, expiry silences", () => {
  const status = normalizeCodexResetStatus(apiPayload(), NOW);
  assert.equal(codexResetMarkLevel(status, NOW), "alert");

  const watchOnly = normalizeCodexResetStatus(apiPayload({
    scheduled_reset: null,
    active_watch: { ...apiPayload().data.active_watch, level: "strong" },
  }), NOW);
  assert.equal(codexResetMarkLevel(watchOnly, NOW), "alert");

  const elevatedOnly = normalizeCodexResetStatus(apiPayload({ scheduled_reset: null }), NOW);
  assert.equal(codexResetMarkLevel(elevatedOnly, NOW), "warning");

  const expired = normalizeCodexResetStatus(apiPayload({
    scheduled_reset: null,
    active_watch: { ...apiPayload().data.active_watch, expires_at: "2026-05-07T00:00:00.000Z" },
  }), NOW);
  assert.equal(codexResetMarkLevel(expired, NOW), null);
});

test("card note is ASCII and prefers scheduled over watch over last reset", () => {
  const status = normalizeCodexResetStatus(apiPayload(), NOW);
  const scheduledFor = "2026-05-08T06:59:00.000Z";
  assert.equal(codexResetCardNote(status, NOW), `Tibo Reset ${formatResetTime(scheduledFor, NOW)}`);

  const due = normalizeCodexResetStatus(apiPayload({
    scheduled_reset: { ...apiPayload().data.scheduled_reset, scheduled_for: "2026-05-07T01:00:00.000Z" },
  }), NOW);
  assert.equal(codexResetCardNote(due, NOW), "Tibo Reset due");

  const tba = normalizeCodexResetStatus(apiPayload({
    scheduled_reset: { ...apiPayload().data.scheduled_reset, scheduled_for: null },
  }), NOW);
  assert.equal(codexResetCardNote(tba, NOW), "Tibo Reset TBA");

  const banked = normalizeCodexResetStatus(apiPayload({
    scheduled_reset: { ...apiPayload().data.scheduled_reset, reset_type: "banked" },
  }), NOW);
  assert.match(codexResetCardNote(banked, NOW) ?? "", /^Tibo Reset \(banked\) /);

  const watchOnly = normalizeCodexResetStatus(apiPayload({
    scheduled_reset: null,
    active_watch: { ...apiPayload().data.active_watch, level: "strong", reset_chance_percent: 71.6 },
  }), NOW);
  assert.equal(codexResetCardNote(watchOnly, NOW), "Tibo watch strong 72%");

  const lastOnly = normalizeCodexResetStatus(apiPayload({
    scheduled_reset: null,
    active_watch: null,
    stats: { total: 1, last_reset_at: "2026-05-02T00:00:00.000Z", days_since_last: 6.2, avg_interval_days: 6.9 },
  }), NOW);
  assert.equal(codexResetCardNote(lastOnly, NOW), "Last Tibo reset 6d ago");
});

test("summary joins every live signal for the tooltip and text fallback", () => {
  const status = normalizeCodexResetStatus(apiPayload(), NOW);
  const scheduledFor = "2026-05-08T06:59:00.000Z";
  assert.equal(
    codexResetSummary(status, NOW),
    `scheduled ${formatResetTime(scheduledFor, NOW)} · watch elevated 55% · last today`,
  );
  assert.equal(codexResetSummary(null, NOW), null);
});

test("notification transitions: first run only speaks for a pending scheduled reset", () => {
  const status = normalizeCodexResetStatus(apiPayload(), NOW);
  const notice = nextCodexResetNotice(status, null, NOW);
  assert.equal(notice?.kind, "scheduled");

  const noScheduled = normalizeCodexResetStatus(apiPayload({ scheduled_reset: null }), NOW);
  assert.equal(nextCodexResetNotice(noScheduled, null, NOW), null);

  // A scheduled reset whose time passed long ago is stale on first sight.
  const staleScheduled = normalizeCodexResetStatus(apiPayload({
    scheduled_reset: { ...apiPayload().data.scheduled_reset, scheduled_for: "2026-05-01T00:00:00.000Z" },
  }), NOW);
  assert.equal(nextCodexResetNotice(staleScheduled, null, NOW), null);
});

test("notification transitions: seen ids gate repeats and freshness gates executed", () => {
  const status = normalizeCodexResetStatus(apiPayload(), NOW);
  const seen = { latestResetId: "reset-1", scheduledResetId: "reset-2", watchObservedAt: "2026-05-07T20:00:00.000Z", watchLevel: "elevated" };
  assert.equal(nextCodexResetNotice(status, seen, NOW), null, "unchanged state never re-notifies");

  const freshExecuted = normalizeCodexResetStatus(apiPayload({
    latest_reset: { ...apiPayload().data.latest_reset, id: "reset-3", announced_at: "2026-05-07T23:00:00.000Z" },
  }), NOW);
  assert.equal(nextCodexResetNotice(freshExecuted, seen, NOW)?.kind, "executed");

  // Reset announced over a day ago while the daemon was down is not news.
  const staleExecuted = normalizeCodexResetStatus(apiPayload({
    latest_reset: { ...apiPayload().data.latest_reset, id: "reset-4", announced_at: "2026-05-06T00:00:00.000Z" },
  }), NOW);
  assert.equal(nextCodexResetNotice(staleExecuted, seen, NOW), null);

  const newScheduled = normalizeCodexResetStatus(apiPayload({
    scheduled_reset: { ...apiPayload().data.scheduled_reset, id: "reset-5" },
  }), NOW);
  assert.equal(nextCodexResetNotice(newScheduled, seen, NOW)?.kind, "scheduled");
});

test("notification transitions: watch fires on appearance or escalation, never on expiry", () => {
  const seen = { latestResetId: "reset-1", scheduledResetId: "reset-2", watchObservedAt: null, watchLevel: null };
  const watchOnly = normalizeCodexResetStatus(apiPayload({ scheduled_reset: null }), NOW);
  assert.equal(nextCodexResetNotice(watchOnly, seen, NOW)?.kind, "watch");

  // Escalation to strong is news even when the forecast itself is too old to
  // count as a fresh appearance.
  const escalated = normalizeCodexResetStatus(apiPayload({
    scheduled_reset: null,
    active_watch: { ...apiPayload().data.active_watch, level: "strong", observed_at: "2026-05-06T10:00:00.000Z" },
  }), NOW);
  assert.equal(
    nextCodexResetNotice(escalated, { ...seen, watchLevel: "elevated", watchObservedAt: "2026-05-07T20:00:00.000Z" }, NOW)?.kind,
    "watch",
  );
  // ...but a strong watch that was already recorded does not re-fire.
  assert.equal(
    nextCodexResetNotice(escalated, { ...seen, watchLevel: "strong", watchObservedAt: "2026-05-06T10:00:00.000Z" }, NOW),
    null,
  );

  const expired = normalizeCodexResetStatus(apiPayload({
    scheduled_reset: null,
    active_watch: { ...apiPayload().data.active_watch, expires_at: "2026-05-07T00:00:00.000Z" },
  }), NOW);
  assert.equal(nextCodexResetNotice(expired, seen, NOW), null);
});

test("executed resets queue ahead of scheduled announcements", () => {
  const seen = { latestResetId: "reset-0", scheduledResetId: null, watchObservedAt: null, watchLevel: null };
  const both = normalizeCodexResetStatus(apiPayload(), NOW);
  // New executed reset wins the cycle over the unseen scheduled announcement.
  assert.equal(nextCodexResetNotice(both, seen, NOW)?.kind, "executed");
  // After the executed id is recorded, the scheduled announcement gets the
  // next cycle instead of both firing at once.
  assert.equal(
    nextCodexResetNotice(both, { ...seen, latestResetId: "reset-1" }, NOW)?.kind,
    "scheduled",
  );
});

test("runCodexResetNotifications: dry-run reports without touching state", () => {
  const paths = freshPaths();
  const status = normalizeCodexResetStatus(apiPayload(), NOW);
  const messages = runCodexResetNotifications(status, { dryRun: true }, paths, NOW);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /\[dry-run\].*Tibo Reset 预告/);
  assert.equal(fs.existsSync(paths.notificationStateFile), false, "dry-run must not record state");
});

test("runCodexResetNotifications: quiet first run still records what was seen", () => {
  const paths = freshPaths();
  const noScheduled = normalizeCodexResetStatus(apiPayload({
    scheduled_reset: null,
    active_watch: { ...apiPayload().data.active_watch, observed_at: "2026-05-01T00:00:00.000Z" },
  }), NOW);
  assert.deepEqual(runCodexResetNotifications(noScheduled, {}, paths, NOW), []);
  const seen = readCodexResetSeen(paths);
  assert.equal(seen?.latestResetId, "reset-1");
  assert.equal(seen?.scheduledResetId, null);
  // The stale watch was recorded, so its next appearance can still notify.
  assert.equal(seen?.watchObservedAt, "2026-05-01T00:00:00.000Z");
});

test("runCodexResetNotifications: no reset data is a no-op", () => {
  const paths = freshPaths();
  assert.deepEqual(runCodexResetNotifications(null, {}, paths, NOW), []);
  assert.equal(fs.existsSync(paths.notificationStateFile), false);
});

test("seen-record writes are idempotent while the upstream state is unchanged", () => {
  const paths = freshPaths();
  const status = normalizeCodexResetStatus(apiPayload(), NOW);
  markCodexResetSeen(null, status, paths, NOW);
  const first = readCodexResetSeen(paths);
  assert.equal(first?.scheduledResetId, "reset-2");
  // Same ids again: notifiedAt must stay put, proving no rewrite happened.
  markCodexResetSeen(null, status, paths, new Date("2026-05-08T01:00:00.000Z"));
  const second = JSON.parse(fs.readFileSync(paths.notificationStateFile, "utf8"))["codex-reset"];
  assert.notEqual(second.notifiedAt, "2026-05-08T01:00:00.000Z");
});

test("formatCodexResetStatusLine renders the CLI summary or empty string", () => {
  const status = normalizeCodexResetStatus(apiPayload(), NOW);
  const line = formatCodexResetStatusLine(status, NOW);
  assert.match(line, /^Tibo Reset  scheduled .* \(in 6h 59m\)/);
  assert.match(line, /watch elevated 55%/);
  assert.match(line, /last 5\/\d+ \d{2}:\d{2}/);
  assert.match(line, /avg 6\.9d/);
  assert.equal(line.match(/scheduled/g)?.length, 1, "no duplicated segments");
  assert.equal(formatCodexResetStatusLine(null, NOW), "");
});

test("reset notification card stacks content and scales long headlines", async () => {
  const { resetNotificationCardSvg } = await import("../dist/card.js");
  const timestamp = resetNotificationCardSvg({
    accent: "#dc2626",
    label: "RESET INCOMING",
    headline: "9/23 14:59",
    detail: "in 19h 6m",
    footnote: "Ladies and gentlemen... start... your... ENGINES.",
  });
  // Stacked layout: label gets its own row under the title, so it can never
  // collide with the headline; long timestamps shrink instead of overflowing.
  assert.match(timestamp, /font-size="26"[^>]*>RESET INCOMING</);
  assert.match(timestamp, /font-size="40"[^>]*>9\/23 14:59</);
  const short = resetNotificationCardSvg({
    accent: "#16a34a",
    label: "RESET DONE",
    headline: "0%",
    detail: "quotas reset",
    footnote: "",
  });
  assert.match(short, /font-size="62"[^>]*>0%</);
});
