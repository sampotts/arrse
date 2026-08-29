import assert from "node:assert/strict";
import test from "node:test";
import { aspectRepairArgs } from "../src/aspect-repair.js";

test("repairs HEVC aspect metadata without transcoding any streams", () => {
  const args = aspectRepairArgs("/media/show.mp4", "/cache/show.mp4", 0, "16:9");
  assert.equal(args[args.indexOf("-c") + 1], "copy");
  assert.equal(args[args.indexOf("-bsf:v:0") + 1], "hevc_metadata=sample_aspect_ratio=1/1");
  assert.equal(args[args.indexOf("-aspect:v:0") + 1], "16:9");
  assert.equal(args.at(-1), "/cache/show.mp4");
});

test("targets the selected video stream and forces the MP4 muxer for M4V", () => {
  const args = aspectRepairArgs("/media/show.m4v", "/cache/show.m4v", 1, "16:9");
  assert.equal(args[args.indexOf("-bsf:v:1") + 1], "hevc_metadata=sample_aspect_ratio=1/1");
  assert.equal(args[args.indexOf("-f") + 1], "mp4");
});
