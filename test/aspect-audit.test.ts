import assert from "node:assert/strict";
import test from "node:test";
import { aspectIssue } from "../src/aspect-audit.js";
import { ProbeStream } from "../src/types.js";

const hevc = (overrides: Partial<ProbeStream> = {}): ProbeStream => ({
  index: 0,
  codec_type: "video",
  codec_name: "hevc",
  width: 1920,
  height: 1080,
  sample_aspect_ratio: "1:1",
  display_aspect_ratio: "16:9",
  ...overrides
});

test("flags the malformed aspect metadata found in affected Arrse output", () => {
  assert.match(aspectIssue(hevc({
    sample_aspect_ratio: "533:360",
    display_aspect_ratio: "1066:405"
  })) ?? "", /expected SAR 1:1, DAR 16:9/);
});

test("accepts correct square-pixel 1080p HEVC", () => {
  assert.equal(aspectIssue(hevc()), undefined);
});

test("does not classify anamorphic or H.264 video", () => {
  assert.equal(aspectIssue(hevc({ width: 1440, height: 1080, sample_aspect_ratio: "4:3" })), undefined);
  assert.equal(aspectIssue(hevc({ codec_name: "h264" })), undefined);
});
