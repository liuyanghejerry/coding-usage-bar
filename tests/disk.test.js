import test from "node:test";
import assert from "node:assert/strict";
import { diskUsageFromReading, probeDiskUsage } from "../dist/disk.js";
import { formatBytes, formatDiskStatus } from "../dist/format.js";

const measuredAt = new Date("2026-09-13T00:00:00.000Z");
const GB = 1024 ** 3;

test("diskUsageFromReading computes used percent from available space", () => {
  const disk = diskUsageFromReading(
    { totalBytes: 500 * GB, availableBytes: 250 * GB },
    "/",
    measuredAt,
  );

  assert.equal(disk.mountPoint, "/");
  assert.equal(disk.totalBytes, 500 * GB);
  assert.equal(disk.availableBytes, 250 * GB);
  assert.equal(disk.usedPercent, 50);
  assert.equal(disk.measuredAt, measuredAt.toISOString());
});

test("diskUsageFromReading clamps available above total instead of going negative", () => {
  // APFS volumes shared across containers can momentarily report bavail above
  // blocks; the bar must not overflow past 0% used.
  const disk = diskUsageFromReading(
    { totalBytes: 100 * GB, availableBytes: 120 * GB },
    "/",
    measuredAt,
  );

  assert.equal(disk.availableBytes, 100 * GB);
  assert.equal(disk.usedPercent, 0);
});

test("diskUsageFromReading rejects nonsense readings", () => {
  assert.equal(diskUsageFromReading({ totalBytes: 0, availableBytes: 0 }, "/", measuredAt), null);
  assert.equal(diskUsageFromReading({ totalBytes: -1, availableBytes: 0 }, "/", measuredAt), null);
  assert.equal(diskUsageFromReading({ totalBytes: Number.NaN, availableBytes: 0 }, "/", measuredAt), null);
  assert.equal(diskUsageFromReading({ totalBytes: 100 * GB, availableBytes: -1 }, "/", measuredAt), null);
});

test("probeDiskUsage reads statfs fields the way df reports them", () => {
  const disk = probeDiskUsage(measuredAt, () => ({ bsize: 4096, blocks: 1000, bavail: 250 }));

  assert.equal(disk.totalBytes, 1000 * 4096);
  assert.equal(disk.availableBytes, 250 * 4096);
  assert.equal(disk.usedPercent, 75);
});

test("probeDiskUsage returns null when statfs fails instead of breaking collection", () => {
  assert.equal(probeDiskUsage(measuredAt, () => { throw new Error("not supported"); }), null);
  assert.equal(probeDiskUsage(measuredAt, () => ({ bsize: 0, blocks: 0, bavail: 0 })), null);
});

test("probeDiskUsage measures the real root volume", () => {
  const disk = probeDiskUsage();

  assert.ok(disk, "statfs on / must work on macOS");
  assert.ok(disk.totalBytes > 0);
  assert.ok(disk.availableBytes >= 0 && disk.availableBytes <= disk.totalBytes);
  assert.ok(disk.usedPercent >= 0 && disk.usedPercent <= 100);
});

test("formatBytes picks a human unit", () => {
  assert.equal(formatBytes(820 * 1024 ** 2), "820 MB");
  assert.equal(formatBytes(230 * GB), "230 GB");
  assert.equal(formatBytes(1.25 * 1024 ** 4), "1.3 TB");
});

test("formatDiskStatus renders one summary line, empty without data", () => {
  assert.equal(formatDiskStatus(null), "");
  assert.equal(formatDiskStatus(undefined), "");

  const line = formatDiskStatus({
    mountPoint: "/",
    totalBytes: 500 * GB,
    availableBytes: 230 * GB,
    usedPercent: 54,
    measuredAt: measuredAt.toISOString(),
  });
  assert.match(line, /^Disk\s+\[#/);
  assert.match(line, /54%/);
  assert.match(line, /230 GB free of 500 GB/);
});
