import assert from "node:assert/strict";
import test from "node:test";
import { ffmpegArgs } from "../src/optimizer.js";
import { Config } from "../src/types.js";

const config: Config = {
  roots: ["/data/TV", "/data/Movies"], cacheDir: "/cache", configDir: "/config",
  workers: 2, dryRun: true, scanIntervalMinutes: 60, minSavingsPercent: 15,
  qsvQuality: 23, qsvPreset: "medium", qsvDevice: "/dev/dri/renderD128"
};

test("ffmpeg uses QSV HEVC for only the content video and copies everything else", () => {
  const args = ffmpegArgs("/data/TV/show.mkv", "/cache/out.mkv", 2, config);
  assert.ok(args.includes("hevc_qsv"));
  assert.ok(args.includes("copy"));
  assert.ok(args.includes("-map_metadata"));
  assert.ok(args.includes("-map_chapters"));
  assert.equal(args[args.indexOf("-c:2") + 1], "hevc_qsv");
  assert.match(args.join(" "), /renderD128/);
});
