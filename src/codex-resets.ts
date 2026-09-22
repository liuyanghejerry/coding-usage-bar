import { formatDurationUntil, formatLocalTime, formatResetTime } from "./format.js";
import {
  CodexResetEvent,
  CodexResetStats,
  CodexResetStatus,
  CodexResetWatch,
} from "./types.js";

// Producer-side client for the Codex Resets public API. The service tracks
// reset announcements (and AI-classified reset watches) for the Codex quota
// windows. The API is free and keyless; in exchange it asks for a visible
// credit link wherever the data is displayed, which the menu bar renders via
// CODEX_RESETS_CREDIT_* below. A failed fetch must never break usage
// collection: callers treat null as "keep the previous reading".

export const CODEX_RESETS_STATUS_URL = "https://codex-resets.com/api/v1/status";
export const CODEX_RESETS_CREDIT_URL = "https://codex-resets.com";
export const CODEX_RESETS_CREDIT_LABEL = "Data from codex-resets.com";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_TEXT_CHARS = 500;
// A reset "executed" announcement older than this is history, not news; it
// must not fire a notification after a long daemon outage.
const EXECUTED_FRESH_MS = 24 * 60 * 60 * 1000;
// Watches are short-lived forecasts; a brand-new watch older than this is not
// worth waking anyone up for.
const WATCH_FRESH_MS = 12 * 60 * 60 * 1000;
// A scheduled reset announced long ago whose time already passed is stale.
const SCHEDULED_STALE_MS = 48 * 60 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asIso(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) {
    return null;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function truncateText(value: unknown): string {
  const raw = asString(value) ?? "";
  return raw.length > MAX_TEXT_CHARS ? `${raw.slice(0, MAX_TEXT_CHARS)}…` : raw;
}

function normalizeSource(source: unknown): Pick<CodexResetEvent, "sourceType" | "sourceAuthor" | "sourceUrl"> {
  const record = asRecord(source);
  const type = record?.type === "x_post" || record?.type === "observed" ? record.type : null;
  return {
    sourceType: type,
    sourceAuthor: type === "x_post" ? asString(record?.author) : null,
    sourceUrl: asString(record?.url),
  };
}

function normalizeEvent(raw: unknown, options: { scheduled: boolean }): CodexResetEvent | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const id = asString(record.id);
  const announcedAt = asIso(record.announced_at);
  if (!id || !announcedAt) {
    return null;
  }
  return {
    id,
    resetType: record.reset_type === "banked" ? "banked" : "regular",
    announcedAt,
    scheduledFor: options.scheduled ? asIso(record.scheduled_for) : null,
    text: truncateText(record.text),
    ...normalizeSource(record.source),
  };
}

function normalizeWatch(raw: unknown): CodexResetWatch | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const level = record.level === "strong" || record.level === "elevated" ? record.level : null;
  const observedAt = asIso(record.observed_at);
  const expiresAt = asIso(record.expires_at);
  if (!level || !observedAt || !expiresAt) {
    return null;
  }
  return {
    level,
    resetChancePercent: asNumber(record.reset_chance_percent),
    forecastWindow: asString(record.forecast_window) ?? "",
    observedAt,
    expiresAt,
    text: truncateText(record.text),
    ...normalizeSource(record.source),
  };
}

function normalizeStats(raw: unknown): CodexResetStats {
  const record = asRecord(raw) ?? {};
  return {
    total: asNumber(record.total) ?? 0,
    lastResetAt: asIso(record.last_reset_at),
    daysSinceLast: asNumber(record.days_since_last),
    avgIntervalDays: asNumber(record.avg_interval_days),
  };
}

// Pure and exported for tests: turns an API payload into the normalized
// status stored in status.json. Returns null for anything unusable.
export function normalizeCodexResetStatus(raw: unknown, fetchedAt: Date): CodexResetStatus | null {
  const envelope = asRecord(raw);
  const data = asRecord(envelope?.data);
  if (!data) {
    return null;
  }
  const latestReset = normalizeEvent(data.latest_reset, { scheduled: false });
  const scheduledReset = normalizeEvent(data.scheduled_reset, { scheduled: true });
  const activeWatch = normalizeWatch(data.active_watch);
  if (!latestReset && !scheduledReset && !activeWatch) {
    return null;
  }
  return {
    latestReset,
    scheduledReset,
    activeWatch,
    stats: normalizeStats(data.stats),
    observedAt: fetchedAt.toISOString(),
    generatedAt: asIso(asRecord(envelope?.meta)?.generated_at) ?? fetchedAt.toISOString(),
  };
}

export async function fetchCodexResetStatus(
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<CodexResetStatus | null> {
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const response = await doFetch(CODEX_RESETS_STATUS_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    return normalizeCodexResetStatus(await response.json(), new Date());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// A watch past its expiry is noise: every consumer treats it as absent.
export function activeCodexResetWatch(
  reset: CodexResetStatus | null | undefined,
  now: Date,
): CodexResetWatch | null {
  const watch = reset?.activeWatch;
  if (!watch) {
    return null;
  }
  const expiresMs = Date.parse(watch.expiresAt);
  return Number.isFinite(expiresMs) && expiresMs > now.getTime() ? watch : null;
}

export type CodexResetMarkLevel = "alert" | "warning" | null;

// Which menu bar dot the reset signal earns: a scheduled reset or a strong
// watch is alert-red, an elevated watch is warning-amber. Null means silent.
export function codexResetMarkLevel(
  reset: CodexResetStatus | null | undefined,
  now: Date,
): CodexResetMarkLevel {
  if (reset?.scheduledReset) {
    return "alert";
  }
  const watch = activeCodexResetWatch(reset, now);
  if (!watch) {
    return null;
  }
  return watch.level === "strong" ? "alert" : "warning";
}

// ASCII-only on purpose: the dropdown card renders through the baked glyph
// atlas, which covers printable ASCII plus a few extras (see glyphCharset).
export function codexResetCardNote(
  reset: CodexResetStatus | null | undefined,
  now: Date,
): string | null {
  if (!reset) {
    return null;
  }
  const scheduled = reset.scheduledReset;
  if (scheduled) {
    const scheduledMs = scheduled.scheduledFor ? Date.parse(scheduled.scheduledFor) : NaN;
    const when = Number.isFinite(scheduledMs)
      ? scheduledMs > now.getTime()
        ? formatResetTime(scheduled.scheduledFor as string, now)
        : "due"
      : "TBA";
    return scheduled.resetType === "banked" ? `Tibo Reset (banked) ${when}` : `Tibo Reset ${when}`;
  }
  const watch = activeCodexResetWatch(reset, now);
  if (watch) {
    const chance = watch.resetChancePercent;
    return `Tibo watch ${watch.level}${chance !== null ? ` ${Math.round(chance)}%` : ""}`;
  }
  const days = reset.stats.daysSinceLast;
  if (days !== null) {
    return days < 1 ? "Tibo reset today" : `Last Tibo reset ${Math.round(days)}d ago`;
  }
  return null;
}

// Multi-segment summary for the title tooltip and the text-only fallback row.
// Unlike the card note this may use "·" (SwiftBar text rows are system font).
export function codexResetSummary(
  reset: CodexResetStatus | null | undefined,
  now: Date,
): string | null {
  if (!reset) {
    return null;
  }
  const parts: string[] = [];
  const scheduled = reset.scheduledReset;
  if (scheduled) {
    const scheduledMs = scheduled.scheduledFor ? Date.parse(scheduled.scheduledFor) : NaN;
    const when = Number.isFinite(scheduledMs)
      ? formatResetTime(scheduled.scheduledFor as string, now)
      : "TBA";
    parts.push(`scheduled ${when}`);
  }
  const watch = activeCodexResetWatch(reset, now);
  if (watch) {
    const chance = watch.resetChancePercent;
    parts.push(`watch ${watch.level}${chance !== null ? ` ${Math.round(chance)}%` : ""}`);
  }
  const days = reset.stats.daysSinceLast;
  if (days !== null) {
    parts.push(`last ${days < 1 ? "today" : `${Math.round(days)}d ago`}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function formatResetCountdown(iso: string, now: Date): string | null {
  const targetMs = Date.parse(iso);
  if (!Number.isFinite(targetMs) || targetMs <= now.getTime()) {
    return null;
  }
  return formatDurationUntil(iso, now);
}

// The next reset transition worth a notification, or null. Pure: state-file
// access and sending live in notifier.ts.
export interface CodexResetNotice {
  kind: "executed" | "scheduled" | "watch";
  event: CodexResetEvent | null;
  watch: CodexResetWatch | null;
}

export interface CodexResetSeenRecord {
  latestResetId?: string | null;
  scheduledResetId?: string | null;
  watchObservedAt?: string | null;
  watchLevel?: string | null;
}

function announcedWithin(iso: string, now: Date, windowMs: number) {
  const announcedMs = Date.parse(iso);
  return Number.isFinite(announcedMs) && now.getTime() - announcedMs <= windowMs;
}

// CLI status line for `coding-usage-bar status`. Mirrors codexResetSummary
// but with local timestamps, the live countdown, and the interval stats the
// terminal can afford.
export function formatCodexResetStatusLine(
  reset: CodexResetStatus | null | undefined,
  now = new Date(),
): string {
  if (!reset) {
    return "";
  }
  const parts: string[] = [];
  const scheduled = reset.scheduledReset;
  if (scheduled) {
    const scheduledIso = scheduled.scheduledFor;
    const countdown = scheduledIso ? formatResetCountdown(scheduledIso, now) : null;
    parts.push(scheduledIso
      ? `scheduled ${countdown ? `${formatResetTime(scheduledIso, now)} (in ${countdown})` : "due"}`
      : "scheduled time TBA");
  }
  const watch = activeCodexResetWatch(reset, now);
  if (watch) {
    const chance = watch.resetChancePercent;
    parts.push(`watch ${watch.level}${chance !== null ? ` ${Math.round(chance)}%` : ""}`);
  }
  if (reset.stats.lastResetAt) {
    parts.push(`last ${formatLocalTime(reset.stats.lastResetAt, now)}`);
  }
  if (reset.stats.avgIntervalDays !== null) {
    parts.push(`avg ${reset.stats.avgIntervalDays.toFixed(1)}d`);
  }
  if (parts.length === 0) {
    return "";
  }
  return `Tibo Reset  ${parts.join(" · ")}`;
}

export function nextCodexResetNotice(
  reset: CodexResetStatus | null | undefined,
  seen: CodexResetSeenRecord | null | undefined,
  now: Date,
): CodexResetNotice | null {
  if (!reset) {
    return null;
  }

  // First observation after install (or state-file loss): record everything,
  // and only speak up about a pending scheduled reset -- the one signal that
  // is still actionable. Old executed resets and ambient watches are history.
  if (!seen) {
    const scheduled = reset.scheduledReset;
    if (!scheduled) {
      return null;
    }
    const scheduledMs = scheduled.scheduledFor ? Date.parse(scheduled.scheduledFor) : NaN;
    const stillRelevant = !Number.isFinite(scheduledMs)
      ? announcedWithin(scheduled.announcedAt, now, SCHEDULED_STALE_MS)
      : scheduledMs > now.getTime() - SCHEDULED_STALE_MS;
    return stillRelevant ? { kind: "scheduled", event: scheduled, watch: null } : null;
  }

  const latest = reset.latestReset;
  if (
    latest
    && latest.id !== (seen.latestResetId ?? null)
    && announcedWithin(latest.announcedAt, now, EXECUTED_FRESH_MS)
  ) {
    return { kind: "executed", event: latest, watch: null };
  }

  const scheduled = reset.scheduledReset;
  if (scheduled && scheduled.id !== (seen.scheduledResetId ?? null)) {
    const scheduledMs = scheduled.scheduledFor ? Date.parse(scheduled.scheduledFor) : NaN;
    const stale = Number.isFinite(scheduledMs) && scheduledMs < now.getTime() - SCHEDULED_STALE_MS;
    if (!stale) {
      return { kind: "scheduled", event: scheduled, watch: null };
    }
  }

  const watch = activeCodexResetWatch(reset, now);
  if (watch && watch.observedAt !== (seen.watchObservedAt ?? null)) {
    const escalated = watch.level === "strong" && seen.watchLevel !== "strong";
    if (escalated || announcedWithin(watch.observedAt, now, WATCH_FRESH_MS)) {
      return { kind: "watch", event: null, watch };
    }
  }

  return null;
}
