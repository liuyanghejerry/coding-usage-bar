export type ProviderId = "claude" | "codex" | "glm" | "deepseek" | "minimax" | "kimi";
export type WindowName = "five_hour" | "seven_day";
export type BurnProfile = "low" | "high";
export type BurnState =
  | "RAW"
  | "UNDER_BURN"
  | "ON_TRACK"
  | "OVER_BURN"
  | "LIMIT_RISK";

export interface UsageWindow {
  name: WindowName;
  windowMinutes: number;
  usedPercent: number;
  resetsAt: string;
}

export interface ProviderUsage {
  provider: ProviderId;
  source: string;
  observedAt: string;
  planType?: string | null;
  windows: UsageWindow[];
  balance?: {
    total: string;
    currency: string;
    isAvailable: boolean;
  };
  // Kimi-only: the billing-cycle (monthly) quota can freeze access while the
  // 5h/weekly windows still report headroom, and that quota is not exposed by
  // /v1/usages at all. When set, window numbers stay untouched; display layers
  // render the bars in a blocked style.
  blocked?: {
    reason: string;
  };
}

export interface BurnAnalysis {
  provider: ProviderId;
  state: BurnState;
  profile: BurnProfile;
  observedAt: string;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  target?: {
    minPercent: number;
    maxPercent: number;
    recommendedPercent: number;
    conversionRate: number;
  };
  message: string;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface GlmConfig {
  baseUrl?: string;
  apiKey?: string;
}

export interface DeepseekConfig {
  apiKey?: string;
}

export interface MinimaxConfig {
  region?: "cn" | "global";
  apiKey?: string;
}

export interface KimiConfig {
  baseUrl?: string;
  apiKey?: string;
}

export interface RuntimePaths {
  homeDir: string;
  stateDir: string;
  configFile: string;
  claudeDir: string;
  codexDir: string;
  glmDir: string;
  deepseekDir: string;
  minimaxDir: string;
  kimiDir: string;
  notificationStateFile: string;
  statusFile: string;
  starPromptFile: string;
  cliBinDir: string;
  cliBinFile: string;
  swiftBarPluginDir: string;
  swiftBarPluginFile: string;
  launchAgentFile: string;
  claudeSettingsFile: string;
  claudeStatusLineScript: string;
  glyphsDir: string;
}

export interface ProviderStatus {
  usage: ProviderUsage;
  analysis: BurnAnalysis;
  meta: {
    source: string;
    observedAt: string;
    ageSeconds: number;
    stale: boolean;
  };
}

export interface StatusIssue {
  provider?: ProviderId;
  severity: "warning" | "error";
  code: string;
  message: string;
}

// Menu bar geometry measured by the producer. The menu bar is the scarcest
// real estate on the machine and a title wider than the space left over is not
// clipped by macOS -- it is pushed left, under the notch and into the app menu
// area, and silently disappears. The display layer picks a title tier from
// this budget; per the producer/display split it never measures the screen.
export interface DisplayGeometry {
  // Logical width of the menu bar screen (NSScreen.screens[0]).
  screenWidthPt: number;
  hasNotch: boolean;
  // Points actually available to menu bar extras. On a notched display that is
  // the whole right-of-notch region; otherwise the screen width minus a
  // conservative reserve for the frontmost app's own menus.
  extrasBudgetPt: number;
  measuredAt: string;
}

// Root-volume disk headroom measured by the producer (fs.statfs, no process
// spawn). AI coding sessions burn disk fast (caches, node_modules, build
// output), so the menu bar tracks it next to the plan quotas. Like
// DisplayGeometry this is producer-only data: the display layer reads it from
// status.json and never measures the disk itself.
export interface DiskUsage {
  mountPoint: string;
  totalBytes: number;
  // Bytes available to an unprivileged process (statfs bavail, what df reports
  // as Avail); purgeable APFS space is not counted.
  availableBytes: number;
  usedPercent: number;
  measuredAt: string;
}

// Codex Resets tracker data (codex-resets.com), fetched producer-side once per
// collection cycle. The service watches for reset announcements and observed
// resets of the Codex 5h/7d quota windows. Like DisplayGeometry and DiskUsage
// this is producer-only data: the display layer reads it from status.json and
// never talks to the network.
export type CodexResetWatchLevel = "elevated" | "strong";
export type CodexResetSourceType = "x_post" | "observed";

export interface CodexResetEvent {
  id: string;
  resetType: "regular" | "banked";
  announcedAt: string;
  // Scheduled announcements only; executed resets are always null.
  scheduledFor: string | null;
  text: string;
  sourceType: CodexResetSourceType | null;
  sourceAuthor: string | null;
  sourceUrl: string | null;
}

export interface CodexResetWatch {
  level: CodexResetWatchLevel;
  resetChancePercent: number | null;
  forecastWindow: string;
  observedAt: string;
  expiresAt: string;
  text: string;
  sourceType: CodexResetSourceType | null;
  sourceAuthor: string | null;
  sourceUrl: string | null;
}

export interface CodexResetStats {
  total: number;
  lastResetAt: string | null;
  daysSinceLast: number | null;
  avgIntervalDays: number | null;
}

export interface CodexResetStatus {
  latestReset: CodexResetEvent | null;
  scheduledReset: CodexResetEvent | null;
  activeWatch: CodexResetWatch | null;
  stats: CodexResetStats;
  // When this host fetched the data.
  observedAt: string;
  // When the upstream service generated it (meta.generated_at).
  generatedAt: string;
}

export interface StatusSnapshot {
  generatedAt: string;
  profile: BurnProfile;
  providers: ProviderStatus[];
  issues: StatusIssue[];
  // Absent on snapshots written before display probing, on non-macOS hosts,
  // and whenever the probe fails. Consumers must degrade, never assume.
  display?: DisplayGeometry | null;
  // Absent on snapshots written before disk probing and whenever statfs
  // fails. Consumers must degrade, never assume.
  disk?: DiskUsage | null;
  // Absent on snapshots written before reset tracking, whenever codex is not
  // monitored, and whenever the fetch fails. Consumers must degrade, never
  // assume.
  codexReset?: CodexResetStatus | null;
}

export interface BurnConfig {
  providers: ProviderId[];
  glm?: GlmConfig;
  deepseek?: DeepseekConfig;
  minimax?: MinimaxConfig;
  kimi?: KimiConfig;
}
