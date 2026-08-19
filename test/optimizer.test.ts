import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { calculateQvbrTarget, cleanupOrphanedCacheFiles, ffmpegArgs, vaapiCqpSelfTestArgs, vaapiQvbrSelfTestArgs } from "../src/optimizer.js";
import { Config } from "../src/types.js";

const config: Config = {
  inputPaths: ["/input"], cacheDir: "/cache", configDir: "/config",
  workers: 2, dryRun: true, scanIntervalMinutes: 60, minSavingsPercent: 15, targetSavingsPercent: 20,
  quality: 20, device: "/dev/dri/renderD128"
};

test("QVBR uses a per-file bitrate with zero-copy VAAPI and copies everything else", () => {
  const args = ffmpegArgs("/media/show.mkv", "/cache/out.mkv", 2, config, "vaapi-qvbr", 4_000_000);
  assert.ok(args.includes("hevc_vaapi"));
  assert.ok(args.includes("copy"));
  assert.ok(args.includes("-map_metadata"));
  assert.ok(args.includes("-map_chapters"));
  assert.equal(args[args.indexOf("-c:2") + 1], "hevc_vaapi");
  assert.equal(args[args.indexOf("-rc_mode:2") + 1], "QVBR");
  assert.equal(args[args.indexOf("-b:2") + 1], "4000000");
  assert.equal(args[args.indexOf("-maxrate:2") + 1], "6400000");
  assert.equal(args[args.indexOf("-bufsize:2") + 1], "8000000");
  assert.equal(args[args.indexOf("-global_quality:2") + 1], "20");
  assert.equal(args[args.indexOf("-low_power:2") + 1], "1");
  assert.equal(args[args.indexOf("-hwaccel") + 1], "vaapi");
  assert.equal(args[args.indexOf("-hwaccel_output_format") + 1], "vaapi");
  assert.match(args.join(" "), /renderD128/);
  assert.equal(args[args.indexOf("-progress") + 1], "pipe:1");
  assert.ok(args.includes("-nostats"));
});

test("QVBR self-test matches the supported Tiger Lake mode", () => {
  const args = vaapiQvbrSelfTestArgs(config);
  assert.equal(args[args.indexOf("-c:v") + 1], "hevc_vaapi");
  assert.equal(args[args.indexOf("-rc_mode:v") + 1], "QVBR");
  assert.equal(args[args.indexOf("-global_quality:v") + 1], "20");
  assert.equal(args[args.indexOf("-low_power:v") + 1], "1");
  assert.equal(args.at(-1), "-");
});

test("CQP fallback self-test performs a one-frame HEVC hardware encode", () => {
  const args = vaapiCqpSelfTestArgs(config);
  assert.equal(args[args.indexOf("-c:v") + 1], "hevc_vaapi");
  assert.equal(args[args.indexOf("-vf") + 1], "format=nv12,hwupload");
  assert.equal(args[args.indexOf("-qp:v") + 1], "20");
  assert.equal(args[args.indexOf("-rc_mode:v") + 1], "CQP");
});

test("CQP fallback uses zero-copy hardware decode and preserves mapped streams", () => {
  const args = ffmpegArgs("/media/show.mkv", "/cache/out.mkv", 2, config, "vaapi-cqp");
  assert.equal(args[args.indexOf("-c:2") + 1], "hevc_vaapi");
  assert.equal(args[args.indexOf("-qp:2") + 1], "20");
  assert.equal(args[args.indexOf("-rc_mode:2") + 1], "CQP");
  assert.equal(args[args.indexOf("-hwaccel") + 1], "vaapi");
  assert.equal(args[args.indexOf("-hwaccel_output_format") + 1], "vaapi");
  assert.ok(!args.some((arg) => arg.startsWith("-filter:")));
  assert.ok(args.includes("copy"));
  assert.ok(!args.includes("hevc_qsv"));
});

test("QVBR target accounts for copied streams and whole-file savings", () => {
  const input = {
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264", bit_rate: "7000000" },
      { index: 1, codec_type: "audio", codec_name: "eac3", bit_rate: "768000" },
      { index: 2, codec_type: "subtitle", codec_name: "subrip", bit_rate: "2000" }
    ],
    format: { duration: "3600" }
  };
  const target = calculateQvbrTarget(input, 4_500_000_000, 20);
  assert.ok(target);
  assert.equal(target.sourceTotalBitrate, 10_000_000);
  assert.equal(target.copiedBitrate, 3_000_000);
  assert.equal(target.videoBitrate, 4_968_000);
});

test("QVBR skips sources whose copied streams consume the size budget", () => {
  const input = {
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264" },
      { index: 1, codec_type: "audio", codec_name: "truehd" }
    ],
    format: { duration: "3600" }
  };
  assert.equal(calculateQvbrTarget(input, 1_800_000_000, 20), undefined);
});

test("QVBR rejects a command without a calculated bitrate", () => {
  assert.throws(() => ffmpegArgs("/media/show.mkv", "/cache/out.mkv", 0, config), /requires a target video bitrate/);
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
