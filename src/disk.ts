import fs from "node:fs";
import { DiskUsage } from "./types.js";

// The boot volume is where AI coding sessions spend disk: package caches,
// node_modules, build output, session logs. v1 tracks that one mount; exotic
// multi-volume setups are out of scope.
const ROOT_MOUNT_POINT = "/";

// Display thresholds shared by the card and the text fallback: a bar at or
// above WARNING turns orange, at or above ALERT turns red and grows a
// cleanup hint.
export const DISK_WARNING_USED_PERCENT = 75;
export const DISK_ALERT_USED_PERCENT = 90;

export interface DiskReading {
  totalBytes: number;
  availableBytes: number;
}

export interface StatfsLike {
  bsize: number;
  blocks: number;
  bavail: number;
}

export type StatfsReader = (mountPoint: string) => StatfsLike;

// Split out from the syscall so the math is testable without a filesystem.
// Returns null for nonsense readings (an empty or unmounted volume reports
// zero blocks), so one bad statfs can never blank the displayed disk row.
export function diskUsageFromReading(
  reading: DiskReading,
  mountPoint: string,
  measuredAt: Date,
): DiskUsage | null {
  if (!Number.isFinite(reading.totalBytes) || reading.totalBytes <= 0) {
    return null;
  }
  if (!Number.isFinite(reading.availableBytes) || reading.availableBytes < 0) {
    return null;
  }
  const availableBytes = Math.min(reading.availableBytes, reading.totalBytes);
  const usedPercent = Math.round(((reading.totalBytes - availableBytes) / reading.totalBytes) * 100);
  return {
    mountPoint,
    totalBytes: Math.round(reading.totalBytes),
    availableBytes: Math.round(availableBytes),
    usedPercent,
    measuredAt: measuredAt.toISOString(),
  };
}

// fs.statfsSync runs in-process: no spawn, no WindowServer, no permission
// prompt, so the producer pays nothing for it on every collection. A failure
// (non-macOS without statfs support, a future Node change) must never take
// usage collection down with it.
export function probeDiskUsage(
  measuredAt: Date = new Date(),
  readStatfs: StatfsReader = (mountPoint) => fs.statfsSync(mountPoint),
): DiskUsage | null {
  try {
    const stats = readStatfs(ROOT_MOUNT_POINT);
    return diskUsageFromReading(
      {
        totalBytes: stats.blocks * stats.bsize,
        availableBytes: stats.bavail * stats.bsize,
      },
      ROOT_MOUNT_POINT,
      measuredAt,
    );
  } catch {
    return null;
  }
}
