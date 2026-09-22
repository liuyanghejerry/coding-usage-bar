import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import {
  CodexResetNotice,
  CodexResetSeenRecord,
  nextCodexResetNotice,
} from "./codex-resets.js";
import { readJsonFile, writeJsonAtomic } from "./fs-util.js";
import { formatDurationUntil, formatLocalTime } from "./format.js";
import { buildPaths, installedAssetPath } from "./paths.js";
import { BurnAnalysis, CodexResetStatus, RuntimePaths } from "./types.js";
import { writeNotificationCard, writeResetNotificationCard, ResetNotificationCardSpec } from "./card.js";

interface NotificationRecord {
  state: string;
  notifiedAt?: string;
  resetAt?: string;
  // Payload of the "codex-reset" key: which upstream events this machine has
  // already seen, so only genuine new announcements notify.
  latestResetId?: string | null;
  scheduledResetId?: string | null;
  watchObservedAt?: string | null;
  watchLevel?: string | null;
}

type NotificationState = Record<string, NotificationRecord>;

// State is keyed by provider. Legacy records were keyed `provider:state` and
// re-notified on a cooldown, which spammed osascript spawns all day; dropping
// those keys makes each provider re-notify once after upgrade, then follow the
// transition-based rules.
function readNotificationState(paths: RuntimePaths): NotificationState {
  const raw = readJsonFile<NotificationState>(paths.notificationStateFile) ?? {};
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !key.includes(":")));
}

export function commandExists(command: string) {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

export function notificationBackend() {
  if (process.platform === "darwin") {
    return commandExists("terminal-notifier") ? "terminal-notifier" : "osascript";
  }
  if (process.platform === "win32") {
    return "burnt-toast";
  }
  return commandExists("notify-send") ? "notify-send" : "unsupported";
}

function cooldownMinutes(profile: "low" | "high") {
  return profile === "high" ? 15 : 30;
}

// Notify only on a state transition or when the 5h window resets while the
// alert persists — never on a periodic cooldown. The cooldown only acts as a
// per-provider floor between notifications so a flapping state cannot spam.
// A zero-usage GLM 5h window reports resetsAt == observedAt, drifting on every
// poll; without a genuinely future boundary there is no window reset to react
// to, so a drifting or already-due resetAt must not re-fire the alert.
export function shouldNotify(
  analysis: BurnAnalysis,
  paths: RuntimePaths = buildPaths(),
  now = new Date(),
) {
  if (analysis.state === "RAW" || analysis.state === "ON_TRACK") {
    return false;
  }
  const previous = readNotificationState(paths)[analysis.provider];
  if (!previous) {
    return true;
  }
  if (previous.state === analysis.state) {
    const resetAt = analysis.fiveHour?.resetsAt;
    const resetMs = resetAt ? Date.parse(resetAt) : NaN;
    const windowResetPending = Number.isFinite(resetMs) && resetMs > now.getTime() + 60_000;
    const sameWindow = !previous.resetAt || !resetAt || previous.resetAt === resetAt;
    if (sameWindow || !windowResetPending) {
      return false;
    }
  }
  if (!previous.notifiedAt) {
    return true;
  }
  const elapsedMinutes = (now.getTime() - Date.parse(previous.notifiedAt)) / 60_000;
  return elapsedMinutes >= cooldownMinutes(analysis.profile);
}

export function markNotified(
  analysis: BurnAnalysis,
  paths: RuntimePaths = buildPaths(),
  now = new Date(),
) {
  const state = readNotificationState(paths);
  writeJsonAtomic(paths.notificationStateFile, {
    ...state,
    [analysis.provider]: {
      state: analysis.state,
      notifiedAt: now.toISOString(),
      resetAt: analysis.fiveHour?.resetsAt,
    },
  });
}

// Record recovery so the next entry into an alert state counts as a transition
// and notifies again. Keeps notifiedAt so the anti-flap floor still applies.
export function markRecovered(analysis: BurnAnalysis, paths: RuntimePaths = buildPaths()) {
  if (analysis.state !== "ON_TRACK") {
    return;
  }
  const state = readNotificationState(paths);
  const previous = state[analysis.provider];
  if (!previous || previous.state === "ON_TRACK") {
    return;
  }
  writeJsonAtomic(paths.notificationStateFile, {
    ...state,
    [analysis.provider]: { ...previous, state: "ON_TRACK" },
  });
}

function notificationText(analysis: BurnAnalysis) {
  const provider = analysis.provider === "claude" ? "Claude" : analysis.provider === "glm" ? "GLM" : analysis.provider === "minimax" ? "MiniMax" : analysis.provider === "deepseek" ? "DeepSeek" : analysis.provider === "kimi" ? "Kimi" : "Codex";
  const suffix = analysis.fiveHour ? `剩 ${formatDurationUntil(analysis.fiveHour.resetsAt)} 重置。` : "";
  if (analysis.state === "UNDER_BURN") {
    return {
      title: `Coding Usage Bar: ${provider} 节奏偏慢`,
      message: `${analysis.message} ${suffix}`.trim(),
    };
  }
  if (analysis.state === "OVER_BURN") {
    return {
      title: `Coding Usage Bar: ${provider} 节奏过快`,
      message: `${analysis.message} ${suffix}`.trim(),
    };
  }
  return {
    title: `Coding Usage Bar: ${provider} 接近限额`,
    message: `${analysis.message} ${suffix}`.trim(),
  };
}

export function iconForAnalysis(analysis: BurnAnalysis) {
  if (analysis.state === "UNDER_BURN") {
    return installedAssetPath(os.homedir(), "coding-usage-bar-under.png");
  }
  if (analysis.state === "OVER_BURN") {
    return installedAssetPath(os.homedir(), "coding-usage-bar-over.png");
  }
  if (analysis.state === "LIMIT_RISK") {
    return installedAssetPath(os.homedir(), "coding-usage-bar-limit.png");
  }
  return installedAssetPath(os.homedir(), "coding-usage-bar-ok.png");
}

function iconUrl(iconPath: string) {
  return pathToFileURL(iconPath).toString();
}

export function sendNotification(analysis: BurnAnalysis, dryRun = false) {
  const backend = notificationBackend();
  const { title, message } = notificationText(analysis);
  const appIcon = iconForAnalysis(analysis);
  if (dryRun) {
    return `[dry-run] ${backend}: dynamic-card ${title} - ${message}`;
  }

  if (backend === "terminal-notifier") {
    const args = ["-title", title, "-message", message, "-group", `coding-usage-bar.${analysis.provider}`];
    const cardPath = writeNotificationCard(analysis);
    if (existsSync(cardPath)) {
      args.push("-contentImage", iconUrl(cardPath));
    }
    if (existsSync(appIcon)) {
      args.push("-appIcon", iconUrl(appIcon));
    }
    execFileSync("terminal-notifier", args);
    return `${backend}: ${title}`;
  }
  if (backend === "osascript") {
    execFileSync("osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]);
    return `${backend}: ${title}`;
  }
  if (backend === "notify-send") {
    execFileSync("notify-send", [title, message]);
    return `${backend}: ${title}`;
  }
  if (os.platform() === "win32") {
    throw new Error("Windows notification unavailable: install PowerShell module BurntToast.");
  }
  throw new Error("Desktop notification unavailable on this platform.");
}

// --- Codex reset events (codex-resets.com) ---

const CODEX_RESET_STATE_KEY = "codex-reset";

function truncateAnnouncement(text: string, maxChars: number) {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

export function readCodexResetSeen(paths: RuntimePaths = buildPaths()): CodexResetSeenRecord | null {
  const raw = readJsonFile<Record<string, NotificationRecord>>(paths.notificationStateFile) ?? {};
  const record = raw[CODEX_RESET_STATE_KEY];
  if (!record) {
    return null;
  }
  return {
    latestResetId: record.latestResetId ?? null,
    scheduledResetId: record.scheduledResetId ?? null,
    watchObservedAt: record.watchObservedAt ?? null,
    watchLevel: record.watchLevel ?? null,
  };
}

export function markCodexResetSeen(
  notice: CodexResetNotice | null,
  reset: CodexResetStatus,
  paths: RuntimePaths,
  now: Date,
) {
  const raw = readJsonFile<Record<string, NotificationRecord>>(paths.notificationStateFile) ?? {};
  const existing = raw[CODEX_RESET_STATE_KEY];
  const record: NotificationRecord = {
    // Record every id the fetch surfaced, notified or not, so a signal that
    // lost priority to a hotter one this cycle never re-fires later.
    state: "codex-reset",
    latestResetId: reset.latestReset?.id ?? null,
    scheduledResetId: reset.scheduledReset?.id ?? null,
    watchObservedAt: reset.activeWatch?.observedAt ?? null,
    watchLevel: reset.activeWatch?.level ?? null,
    notifiedAt: notice ? now.toISOString() : existing?.notifiedAt,
  };
  if (
    existing
    && existing.latestResetId === record.latestResetId
    && existing.scheduledResetId === record.scheduledResetId
    && existing.watchObservedAt === record.watchObservedAt
    && existing.watchLevel === record.watchLevel
    && existing.notifiedAt === record.notifiedAt
  ) {
    return;
  }
  writeJsonAtomic(paths.notificationStateFile, { ...raw, [CODEX_RESET_STATE_KEY]: record });
}

function codexResetNotificationSpec(
  notice: CodexResetNotice,
  now: Date,
): { title: string; message: string; card: ResetNotificationCardSpec; appIcon: string } {
  const RED = "#dc2626";
  const AMBER = "#f59e0b";
  const GREEN = "#16a34a";

  if (notice.kind === "executed" && notice.event) {
    const event = notice.event;
    const author = event.sourceAuthor ? `@${event.sourceAuthor}` : "observed reset";
    const text = truncateAnnouncement(event.text, 90);
    return {
      title: "Coding Usage Bar: Tibo Reset 已执行",
      message: `重置已生效 · ${author} · ${formatLocalTime(event.announcedAt, now)}「${text}」`,
      card: {
        accent: GREEN,
        label: "RESET DONE",
        headline: "0%",
        detail: `5h/7d quotas reset · ${author}`,
        footnote: truncateAnnouncement(event.text, 60),
      },
      appIcon: installedAssetPath(os.homedir(), "coding-usage-bar-ok.png"),
    };
  }

  if (notice.kind === "scheduled" && notice.event) {
    const event = notice.event;
    const scheduledMs = event.scheduledFor ? Date.parse(event.scheduledFor) : NaN;
    const when = Number.isFinite(scheduledMs)
      ? `${formatLocalTime(event.scheduledFor as string, now)}（${formatDurationUntil(event.scheduledFor as string, now)}后）`
      : "时间未定";
    return {
      title: "Coding Usage Bar: Tibo Reset 预告",
      message: `预计 ${when} 重置「${truncateAnnouncement(event.text, 90)}」`,
      card: {
        accent: RED,
        label: "RESET INCOMING",
        headline: Number.isFinite(scheduledMs)
          ? formatLocalTime(event.scheduledFor as string, now)
          : "TBA",
        detail: Number.isFinite(scheduledMs)
          ? `in ${formatDurationUntil(event.scheduledFor as string, now)}`
          : "time to be announced",
        footnote: truncateAnnouncement(event.text, 60),
      },
      appIcon: installedAssetPath(os.homedir(), "coding-usage-bar-limit.png"),
    };
  }

  const watch = notice.watch;
  const chance = watch?.resetChancePercent;
  const strong = watch?.level === "strong";
  return {
    title: "Coding Usage Bar: Tibo Reset 概率上升",
    message: `${strong ? "强信号" : "有迹象"}显示 reset 临近 · 概率 ${chance !== null && chance !== undefined ? `${Math.round(chance)}%` : "未知"}「${truncateAnnouncement(watch?.text ?? "", 90)}」`,
    card: {
      accent: strong ? RED : AMBER,
      label: "RESET WATCH",
      headline: chance !== null && chance !== undefined ? `${Math.round(chance)}%` : (watch?.level ?? "").toUpperCase(),
      detail: `${watch?.level ?? ""} · ${watch?.forecastWindow ?? ""}`.trim(),
      footnote: truncateAnnouncement(watch?.text ?? "", 60),
    },
    appIcon: installedAssetPath(os.homedir(), strong ? "coding-usage-bar-limit.png" : "coding-usage-bar-under.png"),
  };
}

export function sendCodexResetNotification(notice: CodexResetNotice, dryRun = false) {
  const backend = notificationBackend();
  const { title, message, card, appIcon } = codexResetNotificationSpec(notice, new Date());
  if (dryRun) {
    return `[dry-run] ${backend}: dynamic-card ${title} - ${message}`;
  }

  if (backend === "terminal-notifier") {
    const args = ["-title", title, "-message", message, "-group", "coding-usage-bar.codex-reset"];
    const cardPath = writeResetNotificationCard(card);
    if (existsSync(cardPath)) {
      args.push("-contentImage", iconUrl(cardPath));
    }
    if (existsSync(appIcon)) {
      args.push("-appIcon", iconUrl(appIcon));
    }
    execFileSync("terminal-notifier", args);
    return `${backend}: ${title}`;
  }
  if (backend === "osascript") {
    execFileSync("osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]);
    return `${backend}: ${title}`;
  }
  if (backend === "notify-send") {
    execFileSync("notify-send", [title, message]);
    return `${backend}: ${title}`;
  }
  if (os.platform() === "win32") {
    throw new Error("Windows notification unavailable: install PowerShell module BurntToast.");
  }
  throw new Error("Desktop notification unavailable on this platform.");
}

// Daemon-side entry: evaluate the reset status against the seen-record, fire
// at most one notification per cycle, and persist what was seen. Dry-run
// reports instead of sending and leaves the state file untouched.
export function runCodexResetNotifications(
  reset: CodexResetStatus | null | undefined,
  options: { dryRun?: boolean } = {},
  paths: RuntimePaths = buildPaths(),
  now = new Date(),
): string[] {
  if (!reset) {
    return [];
  }
  const seen = readCodexResetSeen(paths);
  const notice = nextCodexResetNotice(reset, seen, now);
  if (options.dryRun) {
    if (!notice) {
      return [];
    }
    const { title, message } = codexResetNotificationSpec(notice, now);
    return [`[dry-run] ${notificationBackend()}: dynamic-card ${title} - ${message}`];
  }
  const messages: string[] = [];
  if (notice) {
    try {
      messages.push(sendCodexResetNotification(notice, false));
    } catch (error) {
      messages.push(`codex-reset notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  markCodexResetSeen(notice, reset, paths, now);
  return messages;
}
