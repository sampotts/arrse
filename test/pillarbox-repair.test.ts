import assert from "node:assert/strict";
import test from "node:test";
import { detectHorizontalBounds, pillarboxInputState, pillarboxRepairArgs, pillarboxTargets } from "../src/pillarbox-repair.js";

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

test("physically crops and re-encodes video while copying every other stream", () => {
  const args = pillarboxRepairArgs("/media/input.mp4", "/cache/output.mp4", 0, geometry);
  assert.equal(args[args.indexOf("-c") + 1], "copy");
  assert.equal(args[args.indexOf("-filter:0") + 1], "crop=1350:1080:284:0,setsar=64/45,format=nv12,hwupload");
  assert.equal(args[args.indexOf("-c:0") + 1], "hevc_vaapi");
  assert.equal(args[args.indexOf("-rc_mode:0") + 1], "CQP");
  assert.equal(args[args.indexOf("-qp:0") + 1], "16");
  assert.equal(args[args.indexOf("-aspect:0") + 1], "16:9");
  assert.ok(!args.some((arg) => arg.includes("hevc_metadata")));
});

test("re-encodes an already metadata-cropped input without cropping it twice", () => {
  const args = pillarboxRepairArgs("/media/input.mp4", "/cache/output.mp4", 0, geometry, true);
  assert.equal(args[args.indexOf("-filter:0") + 1], "setsar=64/45,format=nv12,hwupload");
});

test("distinguishes pending, metadata-only and completed physical repairs", () => {
  assert.equal(pillarboxInputState(
    { index: 0, width: 1920, height: 1080, coded_width: 1920 },
    geometry
  ), "needs-crop");
  assert.equal(pillarboxInputState(
    { index: 0, width: 1350, height: 1080, coded_width: 1920 },
    geometry
  ), "metadata-cropped");
  assert.equal(pillarboxInputState(
    { index: 0, width: 1350, height: 1080, coded_width: 1350 },
    geometry
  ), "repaired");
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
