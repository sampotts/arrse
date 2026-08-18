import assert from "node:assert/strict";
import test from "node:test";
import { eligibility, hdrReason, validateTranscode } from "../src/probe.js";
import { ProbeResult, ProbeStream } from "../src/types.js";

const video = (overrides: Partial<ProbeStream> = {}): ProbeStream => ({
  index: 0,
  codec_type: "video",
  codec_name: "h264",
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

test("validates codec, copied streams, chapters and duration", () => {
  const input = media(video());
  const output = media(video({ codec_name: "hevc" }), "100.4");
  assert.deepEqual(validateTranscode(input, output), []);

  output.streams[1].codec_name = "opus";
  output.chapters = [];
  output.format!.duration = "90";
  assert.equal(validateTranscode(input, output).length, 3);
});
