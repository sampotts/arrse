import assert from "node:assert/strict";
import test from "node:test";
import { eligibility, hdrReason, mediaDuration, progressFrameRate, targetAspectRatio, validateTranscode } from "../src/probe.js";
import { ProbeResult, ProbeStream } from "../src/types.js";

const video = (overrides: Partial<ProbeStream> = {}): ProbeStream => ({
  index: 0,
  codec_type: "video",
  codec_name: "h264",
  width: 1920,
  height: 1080,
  sample_aspect_ratio: "1:1",
  display_aspect_ratio: "16:9",
  nb_read_packets: "2400",
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

test("accepts unspecified aspect metadata but rejects conflicting standard-HD metadata", () => {
  assert.equal(eligibility(media(video({
    sample_aspect_ratio: undefined,
    display_aspect_ratio: undefined
  }))).eligible, true);
  const malformed = eligibility(media(video({
    sample_aspect_ratio: "533:360",
    display_aspect_ratio: "1066:405"
  })));
  assert.equal(malformed.eligible, false);
  if (!malformed.eligible) assert.match(malformed.reason, /suspicious aspect metadata/);
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

test("prefers content-video duration over misleading container duration", () => {
  const input = media(video({ duration: "1157.48" }), "2997.20");
  assert.equal(mediaDuration(input), 1157.48);
});

test("uses agreeing timing evidence instead of bogus stream durations", () => {
  const input = media(video({ duration: "64.73", tags: { DURATION: "00:30:00.000000000" } }), "1800");
  input.streams[1].duration = "1800";
  assert.equal(mediaDuration(input), 1800);
});

test("uses nominal cadence when container arithmetic distorts average frame rate", () => {
  const input = media(video({ avg_frame_rate: "213445/6441", r_frame_rate: "25/1" }));
  const output = media(video({ codec_name: "hevc", avg_frame_rate: "804775/32198", r_frame_rate: "25/1" }));
  assert.deepEqual(validateTranscode(input, output), []);
});

test("accepts a 50 Hz field rate when actual output cadence remains 25 fps", () => {
  const input = media(video({ avg_frame_rate: "213445/6441", r_frame_rate: "50/1" }));
  const output = media(video({ codec_name: "hevc", avg_frame_rate: "804775/32198", r_frame_rate: "25/1" }));
  assert.deepEqual(validateTranscode(input, output), []);
});

test("rejects an actual 50 to 25 fps conversion", () => {
  const input = media(video({ avg_frame_rate: "50/1", r_frame_rate: "50/1" }));
  const output = media(video({ codec_name: "hevc", avg_frame_rate: "25/1", r_frame_rate: "25/1" }));
  assert.ok(validateTranscode(input, output).some((error) => error.includes("frame rate changed")));
});

test("uses frame cadence rather than a misleading computed average for progress", () => {
  assert.equal(progressFrameRate(video({ avg_frame_rate: "213445/6441", r_frame_rate: "50/1" })), 25);
  assert.equal(progressFrameRate(video({ avg_frame_rate: "50/1", r_frame_rate: "50/1" })), 50);
});

test("accepts agreeing container durations when stream durations are bogus", () => {
  const input = media(video({ duration: "64.73" }), "1800");
  const output = media(video({ codec_name: "hevc", duration: "28.75" }), "1800.4");
  assert.deepEqual(validateTranscode(input, output), []);
});

test("rejects truncated video even when copied audio keeps the container duration intact", () => {
  const input = media(video({ duration: "7800", nb_read_packets: "187013" }), "7800");
  const output = media(video({ codec_name: "hevc", duration: "7800", nb_read_packets: "28142" }), "7800");
  const errors = validateTranscode(input, output);
  assert.ok(errors.some((error) => error.includes("video packet count changed")));
});

test("rejects output when video packet counts cannot be verified", () => {
  const input = media(video({ nb_read_packets: undefined }));
  const output = media(video({ codec_name: "hevc", nb_read_packets: undefined }));
  assert.ok(validateTranscode(input, output).includes("video packet count is unavailable"));
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

test("matches the transcoded video by mapped stream index", () => {
  const input = media(video({ index: 1 }));
  input.streams.unshift(video({ index: 0, codec_name: "mjpeg", disposition: { attached_pic: 1 } }));
  const output = media(video({ index: 1, codec_name: "hevc", disposition: { attached_pic: 1 } }));
  output.streams.unshift(video({ index: 0, codec_name: "mjpeg", disposition: { attached_pic: 1 } }));
  assert.deepEqual(validateTranscode(input, output), []);
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

test("normalizes standard HD frames to square pixels", () => {
  assert.deepEqual(targetAspectRatio(video({
    sample_aspect_ratio: "533:360",
    display_aspect_ratio: "1066:405"
  })), { sample: "1:1", display: "16:9" });
});

test("preserves anamorphic aspect ratios for nonstandard frame dimensions", () => {
  assert.deepEqual(targetAspectRatio(video({
    width: 1440,
    height: 1080,
    sample_aspect_ratio: "4:3",
    display_aspect_ratio: "16:9"
  })), { sample: "4:3", display: "16:9" });
});

test("rejects malformed aspect metadata on standard HD output", () => {
  const input = media(video({ sample_aspect_ratio: "533:360", display_aspect_ratio: "1066:405" }));
  const output = media(video({ codec_name: "hevc", sample_aspect_ratio: "533:360", display_aspect_ratio: "1066:405" }));
  const errors = validateTranscode(input, output);
  assert.ok(errors.some((error) => error.includes("sample aspect ratio is incorrect")));
  assert.ok(errors.some((error) => error.includes("display aspect ratio is incorrect")));
});
