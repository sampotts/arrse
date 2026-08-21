import assert from "node:assert/strict";
import test from "node:test";
import { createMilestoneProgress, formatBytes, formatDuration, formatProgressMessage, formatSavedResult, formatSavingsDetail, formatSkippedResult, ProgressMilestone } from "../src/progress.js";

test("reports 25/50/75/100 milestones with speed-based ETAs", () => {
  const milestones: ProgressMilestone[] = [];
  const progress = createMilestoneProgress(100, (value) => milestones.push(value));

  progress("out_time_us=26000000\nspeed=2.0x\nprogress=continue\n");
  progress("out_time_us=51000000\nspeed=2.5x\nprogress=continue\n");
  progress("out_time_us=76000000\nspeed=2.0x\nprogress=continue\n");
  progress("out_time_us=100000000\nspeed=2.0x\nprogress=end\n");

  assert.deepEqual(milestones.map(({ percent }) => percent), [25, 50, 75, 100]);
  assert.equal(milestones[0].etaSeconds, 37);
  assert.equal(milestones[1].etaSeconds, 19.6);
  assert.equal(milestones[2].etaSeconds, 12);
  assert.equal(milestones[3].etaSeconds, 0);
});

test("handles progress records split across output chunks", () => {
  const milestones: ProgressMilestone[] = [];
  const progress = createMilestoneProgress(100, (value) => milestones.push(value));
  progress("out_time_us=5000");
  progress("0000\nspeed=1.0x\nprogress=continue\n");
  assert.deepEqual(milestones.map(({ percent }) => percent), [25, 50]);
});

test("formats the concise progress log message", () => {
  assert.equal(formatProgressMessage(50, 434, "/path/to/file.mp4"), `50% (ETA 7m 14s) "/path/to/file.mp4"`);
  assert.equal(formatProgressMessage(100, 0, "/path/to/file.mp4"), `Done! "/path/to/file.mp4"`);
});

test("formats saved bytes without JSON", () => {
  assert.equal(formatBytes(2_340_000_000), "2.34GB");
  assert.equal(formatBytes(42_000_000), "42.00MB");
});

test("formats verified savings outcomes with emojis", () => {
  assert.equal(
    formatSavedResult(50, 4_680_000_000, 2_340_000_000, "/path/to/file.mp4"),
    `✅ Success. Saved 50.00% (4.68GB → 2.34GB) "/path/to/file.mp4"`
  );
  assert.equal(
    formatSkippedResult(-156.67, 15, "/path/to/file.mp4"),
    `⚠️ Output was 156.67% larger than the source; minimum saving is 15%. "/path/to/file.mp4"`
  );
  assert.equal(
    formatSkippedResult(8.5, 15, "/path/to/file.mp4"),
    `⚠️ Output saved 8.50%; minimum saving is 15%. "/path/to/file.mp4"`
  );
  assert.equal(formatSavingsDetail(-156.67), "156.67% larger");
});

test("formats human-readable ETAs", () => {
  assert.equal(formatDuration(42), "42s");
  assert.equal(formatDuration(142), "2m 22s");
  assert.equal(formatDuration(5_000), "1h 23m");
});
