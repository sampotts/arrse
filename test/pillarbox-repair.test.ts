import assert from "node:assert/strict";
import test from "node:test";
import { detectHorizontalBounds, pillarboxRepairArgs, pillarboxTargets } from "../src/pillarbox-repair.js";

const geometry = {
  expectedWidth: 1920,
  expectedHeight: 1080,
  cropLeft: 284,
  cropRight: 286,
  sampleAspectRatio: "64:45"
};

test("calculates the measured PAL anamorphic display geometry", () => {
  assert.deepEqual(pillarboxTargets(geometry), {
    activeWidth: 1350,
    displayAspect: "16:9",
    muxAspect: "1024:405"
  });
});

test("stream-copies while applying HEVC conformance crop and PAL SAR", () => {
  const args = pillarboxRepairArgs("/media/input.mp4", "/cache/output.mp4", 0, geometry);
  assert.equal(args[args.indexOf("-c") + 1], "copy");
  assert.equal(
    args[args.indexOf("-bsf:v:0") + 1],
    "hevc_metadata=crop_left=284:crop_right=286:crop_top=0:crop_bottom=0:sample_aspect_ratio=64/45"
  );
  assert.equal(args[args.indexOf("-aspect:v:0") + 1], "1024:405");
});

test("detects horizontal black borders in a grayscale frame", () => {
  const width = 12;
  const height = 4;
  const frame = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 2; x <= 8; x += 1) frame[y * width + x] = 200;
  }
  assert.deepEqual(detectHorizontalBounds(frame, width, height), {
    left: 2,
    right: 8,
    activeWidth: 7
  });
});
