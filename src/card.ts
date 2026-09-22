import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./fs-util.js";
import { formatDurationUntil } from "./format.js";
import { buildPaths } from "./paths.js";
import { BurnAnalysis, RuntimePaths } from "./types.js";

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function providerLabel(provider: string) {
  if (provider === "claude") return "Claude";
  if (provider === "glm") return "GLM";
  if (provider === "deepseek") return "DeepSeek";
  return "Codex";
}

function cardTheme(state: string) {
  if (state === "UNDER_BURN") {
    return { accent: "#f59e0b", label: "BURN LOW" };
  }
  if (state === "OVER_BURN") {
    return { accent: "#7c3aed", label: "TOO FAST" };
  }
  if (state === "LIMIT_RISK") {
    return { accent: "#dc2626", label: "LIMIT RISK" };
  }
  return { accent: "#16a34a", label: "ON TRACK" };
}

function targetLine(analysis: BurnAnalysis) {
  if (analysis.state === "LIMIT_RISK") {
    return "near plan limit";
  }
  if (!analysis.target) {
    return "learning baseline";
  }
  return `target ${Math.round(analysis.target.minPercent)}-${Math.round(analysis.target.maxPercent)}%`;
}

export function notificationCardSvg(analysis: BurnAnalysis) {
  const theme = cardTheme(analysis.state);
  const used = analysis.fiveHour ? `${Math.round(analysis.fiveHour.usedPercent)}%` : "--";
  const reset = analysis.fiveHour ? `${formatDurationUntil(analysis.fiveHour.resetsAt)} left` : "no reset data";
  const title = `${providerLabel(analysis.provider)} 5h`;
  const target = targetLine(analysis);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="180" viewBox="0 0 420 180">
  <rect width="420" height="180" rx="28" fill="#111827"/>
  <rect x="0" y="0" width="12" height="180" fill="${theme.accent}"/>
  <text x="30" y="45" fill="#f9fafb" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="700">${escapeXml(title)}</text>
  <text x="30" y="116" fill="${theme.accent}" font-family="Arial, Helvetica, sans-serif" font-size="62" font-weight="800">${escapeXml(used)}</text>
  <text x="214" y="64" fill="#f9fafb" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="700">${escapeXml(theme.label)}</text>
  <text x="214" y="104" fill="#d1d5db" font-family="Arial, Helvetica, sans-serif" font-size="22">${escapeXml(target)}</text>
  <text x="214" y="138" fill="#9ca3af" font-family="Arial, Helvetica, sans-serif" font-size="21">${escapeXml(reset)}</text>
</svg>
`;
}

export function cardPathForAnalysis(
  analysis: BurnAnalysis,
  paths: RuntimePaths = buildPaths(),
) {
  const fileName = `${analysis.provider}-${analysis.state.toLowerCase()}.png`;
  return path.join(paths.stateDir, "cards", fileName);
}

export function writeNotificationCard(
  analysis: BurnAnalysis,
  paths: RuntimePaths = buildPaths(),
) {
  const pngPath = cardPathForAnalysis(analysis, paths);
  const svgPath = pngPath.replace(/\.png$/, ".svg");
  ensureDir(path.dirname(pngPath));
  fs.writeFileSync(svgPath, notificationCardSvg(analysis), "utf8");
  try {
    execFileSync("sips", ["-s", "format", "png", svgPath, "--out", pngPath], {
      stdio: "ignore",
    });
    return pngPath;
  } catch {
    return svgPath;
  }
}

// Reset events get their own notification card: a reset announcement is rare
// and time-sensitive, so the visual must read as an event, not as another
// burn-rate blip. Same geometry as the burn card, event-grade accent color.
// Unlike the burn card (whose headline is a short "10%"), the reset headline
// can be a full timestamp, so content stacks in one column and the font size
// adapts instead of colliding with a side column.
export interface ResetNotificationCardSpec {
  accent: string;
  label: string;
  headline: string;
  detail: string;
  footnote: string;
}

export function resetNotificationCardSvg(spec: ResetNotificationCardSpec) {
  const headlineSize = spec.headline.length <= 5 ? 62 : spec.headline.length <= 10 ? 40 : 30;
  const footnote = spec.footnote.length > 46 ? `${spec.footnote.slice(0, 46)}…` : spec.footnote;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="200" viewBox="0 0 420 200">
  <rect width="420" height="200" rx="28" fill="#111827"/>
  <rect x="0" y="0" width="12" height="200" fill="${escapeXml(spec.accent)}"/>
  <text x="30" y="42" fill="#f9fafb" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700">Tibo Reset</text>
  <text x="30" y="74" fill="${escapeXml(spec.accent)}" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700">${escapeXml(spec.label)}</text>
  <text x="30" y="128" fill="${escapeXml(spec.accent)}" font-family="Arial, Helvetica, sans-serif" font-size="${headlineSize}" font-weight="800">${escapeXml(spec.headline)}</text>
  <text x="30" y="160" fill="#d1d5db" font-family="Arial, Helvetica, sans-serif" font-size="22">${escapeXml(spec.detail)}</text>
  <text x="30" y="188" fill="#9ca3af" font-family="Arial, Helvetica, sans-serif" font-size="20">${escapeXml(footnote)}</text>
</svg>
`;
}

export function resetCardPath(spec: ResetNotificationCardSpec, paths: RuntimePaths = buildPaths()) {
  const fileName = `codex-reset-${spec.label.toLowerCase().replaceAll(" ", "-")}.png`;
  return path.join(paths.stateDir, "cards", fileName);
}

export function writeResetNotificationCard(
  spec: ResetNotificationCardSpec,
  paths: RuntimePaths = buildPaths(),
) {
  const pngPath = resetCardPath(spec, paths);
  const svgPath = pngPath.replace(/\.png$/, ".svg");
  ensureDir(path.dirname(pngPath));
  fs.writeFileSync(svgPath, resetNotificationCardSvg(spec), "utf8");
  try {
    execFileSync("sips", ["-s", "format", "png", svgPath, "--out", pngPath], {
      stdio: "ignore",
    });
    return pngPath;
  } catch {
    return svgPath;
  }
}
