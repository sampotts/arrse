import assert from "node:assert/strict";
import test from "node:test";
import { eligibility, hdrReason, validateTranscode } from "../src/probe.js";
import { ProbeResult, ProbeStream } from "../src/types.js";

const video = (overrides: Partial<ProbeStream> = {}): ProbeStream => ({
  index: 0,
  codec_type: "video",
  codec_name: "h264",
  width: 1920,
  height: 1080,
  display_aspect_ratio: "16:9",
  avg_frame_rate: "24000/1001",
  color_primaries: "bt709",
  color_transfer: "bt709",
  color_space: "bt709",
  disposition: { attached_pic: 0 },
  ...overrides
});

const media = (stream: ProbeStream, duration = "100"): ProbeResult => ({
  streams: [stream, { index: 1, codec_type: "audio", codec_name: "aac" }],
  chapters: [{ id: 0 }],
  format: { duration }
});

test("accepts one SDR H.264 content stream", () => {
  assert.equal(eligibility(media(video())).eligible, true);
});

test("rejects HEVC and AV1", () => {
  assert.deepEqual(eligibility(media(video({ codec_name: "hevc" }))), { eligible: false, reason: "video codec is hevc" });
  assert.deepEqual(eligibility(media(video({ codec_name: "av1" }))), { eligible: false, reason: "video codec is av1" });
});

test("detects PQ, HLG, Dolby Vision and mastering metadata", () => {
  assert.match(hdrReason(video({ color_transfer: "smpte2084" })) ?? "", /HDR transfer/);
  assert.match(hdrReason(video({ color_transfer: "arib-std-b67" })) ?? "", /HDR transfer/);
  assert.equal(hdrReason(video({ codec_tag_string: "dvh1" })), "Dolby Vision metadata");
  assert.equal(hdrReason(video({ side_data_list: [{ side_data_type: "Mastering display metadata" }] })), "HDR mastering metadata");
});

test("ignores attached artwork when counting content video", () => {
  const input = media(video());
  input.streams.push(video({ index: 2, codec_name: "mjpeg", disposition: { attached_pic: 1 } }));
  assert.equal(eligibility(input).eligible, true);
});

test("rejects an unknown subtitle codec that cannot be preserved", () => {
  const input = media(video());
  input.streams.push({ index: 2, codec_type: "subtitle" });
  assert.deepEqual(eligibility(input), {
    eligible: false,
    reason: "subtitle stream 2 codec is unknown and cannot be preserved"
  });
});

test("rejects unknown data streams before remuxing MP4", () => {
  const input = media(video());
  input.streams.push({ index: 2, codec_type: "data", codec_name: "none" });
  assert.deepEqual(eligibility(input), {
    eligible: false,
    reason: "data stream 2 codec is unknown and cannot be preserved"
  });
});

test("rejects video tracks without dimensions before remuxing MKV", () => {
  const input = media(video());
  input.streams.push(video({ index: 2, codec_name: "mjpeg", width: undefined, disposition: { attached_pic: 1 } }));
  assert.deepEqual(eligibility(input), {
    eligible: false,
    reason: "video stream 2 dimensions are missing and cannot be preserved"
  });
});

test("validates codec, copied streams, chapters and duration", () => {
  const input = media(video());
  const output = media(video({ codec_name: "hevc" }), "100.4");
  assert.deepEqual(validateTranscode(input, output), []);

  output.streams[1].codec_name = "opus";
  output.chapters = [];
  output.format!.duration = "90";
  assert.equal(validateTranscode(input, output).length, 3);
});

test("rejects changes to core picture characteristics", () => {
  const input = media(video());
  const output = media(video({
    codec_name: "hevc",
    width: 1280,
    avg_frame_rate: "25/1",
    color_space: "bt2020nc"
  }));
  const errors = validateTranscode(input, output);
  assert.ok(errors.some((error) => error.includes("dimensions changed")));
  assert.ok(errors.some((error) => error.includes("frame rate changed")));
  assert.ok(errors.some((error) => error.includes("color_space changed")));
});
