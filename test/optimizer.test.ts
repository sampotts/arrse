import assert from "node:assert/strict";
import test from "node:test";
import { ffmpegArgs, qsvSelfTestArgs } from "../src/optimizer.js";
import { Config } from "../src/types.js";

const config: Config = {
  inputPaths: ["/input"], cacheDir: "/cache", configDir: "/config",
  workers: 2, dryRun: true, scanIntervalMinutes: 60, minSavingsPercent: 15,
  qsvQuality: 20, qsvPreset: "medium", qsvDevice: "/dev/dri/renderD128"
};

test("ffmpeg uses QSV HEVC for only the content video and copies everything else", () => {
  const args = ffmpegArgs("/media/show.mkv", "/cache/out.mkv", 2, config);
  assert.ok(args.includes("hevc_qsv"));
  assert.ok(args.includes("copy"));
  assert.ok(args.includes("-map_metadata"));
  assert.ok(args.includes("-map_chapters"));
  assert.equal(args[args.indexOf("-c:2") + 1], "hevc_qsv");
  assert.equal(args[args.indexOf("-q:2") + 1], "20");
  assert.ok(!args.includes("-global_quality:2"));
  assert.equal(args[args.indexOf("-low_power:2") + 1], "0");
  assert.ok(!args.includes("-hwaccel"));
  assert.match(args.join(" "), /renderD128/);
});

test("QSV self-test performs a one-frame HEVC hardware encode", () => {
  const args = qsvSelfTestArgs(config);
  assert.equal(args[args.indexOf("-c:v") + 1], "hevc_qsv");
  assert.equal(args[args.indexOf("-frames:v") + 1], "1");
  assert.equal(args[args.indexOf("-q:v") + 1], "20");
  assert.equal(args[args.indexOf("-low_power:v") + 1], "0");
  assert.equal(args.at(-1), "-");
});
