import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupOrphanedCacheFiles, ffmpegArgs, qsvSelfTestArgs, vaapiSelfTestArgs } from "../src/optimizer.js";
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

test("VAAPI fallback self-test performs a one-frame HEVC hardware encode", () => {
  const args = vaapiSelfTestArgs(config);
  assert.equal(args[args.indexOf("-c:v") + 1], "hevc_vaapi");
  assert.equal(args[args.indexOf("-vf") + 1], "format=nv12,hwupload");
  assert.equal(args[args.indexOf("-qp:v") + 1], "20");
});

test("VAAPI fallback uses zero-copy hardware decode and preserves mapped streams", () => {
  const args = ffmpegArgs("/media/show.mkv", "/cache/out.mkv", 2, config, "vaapi");
  assert.equal(args[args.indexOf("-c:2") + 1], "hevc_vaapi");
  assert.equal(args[args.indexOf("-qp:2") + 1], "20");
  assert.equal(args[args.indexOf("-hwaccel") + 1], "vaapi");
  assert.equal(args[args.indexOf("-hwaccel_output_format") + 1], "vaapi");
  assert.ok(!args.some((arg) => arg.startsWith("-filter:")));
  assert.ok(args.includes("copy"));
  assert.ok(!args.includes("hevc_qsv"));
});

test("startup removes only orphaned Arrse cache outputs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arrse-cache-"));
  const orphan = "0123456789abcdef-12345678-1234-4234-9234-123456789abc.mkv";
  try {
    await writeFile(path.join(directory, orphan), "partial");
    await writeFile(path.join(directory, "keep-me.mkv"), "unrelated");
    assert.equal(await cleanupOrphanedCacheFiles(directory), 1);
    await assert.rejects(() => stat(path.join(directory, orphan)));
    assert.equal((await stat(path.join(directory, "keep-me.mkv"))).isFile(), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
