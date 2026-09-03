import { run } from "./process.js";
import { ProbeResult, ProbeStream } from "./types.js";

export interface AspectTarget {
  sample?: string;
  display?: string;
}

const STANDARD_SQUARE_PIXEL_FRAMES = new Set([
  "1280x720", "720x1280",
  "1920x1080", "1080x1920",
  "2560x1440", "1440x2560",
  "3840x2160", "2160x3840",
  "7680x4320", "4320x7680"
]);

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a || 1;
}

function ratioValue(value?: string): number | undefined {
  if (!value || value === "N/A") return undefined;
  const [numerator, denominator = 1] = value.split(/[:/]/).map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  return numerator / denominator;
}

function ratiosEqual(left?: string, right?: string): boolean {
  const leftValue = ratioValue(left);
  const rightValue = ratioValue(right);
  return leftValue !== undefined && rightValue !== undefined && Math.abs(leftValue - rightValue) / Math.abs(leftValue) < 0.005;
}

export function isStandardSquarePixelFrame(stream: ProbeStream): boolean {
  return Boolean(stream.width && stream.height && STANDARD_SQUARE_PIXEL_FRAMES.has(`${stream.width}x${stream.height}`));
}

export function aspectRatioMatches(stream: ProbeStream, target: AspectTarget): boolean {
  return (!target.sample || ratiosEqual(target.sample, stream.sample_aspect_ratio))
    && (!target.display || ratiosEqual(target.display, stream.display_aspect_ratio));
}

export function aspectRatioConflicts(stream: ProbeStream, target: AspectTarget): boolean {
  const sampleIsSpecified = ratioValue(stream.sample_aspect_ratio) !== undefined;
  const displayIsSpecified = ratioValue(stream.display_aspect_ratio) !== undefined;
  return Boolean(sampleIsSpecified && target.sample && !ratiosEqual(target.sample, stream.sample_aspect_ratio))
    || Boolean(displayIsSpecified && target.display && !ratiosEqual(target.display, stream.display_aspect_ratio));
}

export function targetAspectRatio(stream: ProbeStream): AspectTarget {
  const { width, height } = stream;
  if (width && height && isStandardSquarePixelFrame(stream)) {
    const divisor = greatestCommonDivisor(width, height);
    return {
      sample: "1:1",
      display: `${width / divisor}:${height / divisor}`
    };
  }
  return {
    sample: ratioValue(stream.sample_aspect_ratio) === undefined ? undefined : stream.sample_aspect_ratio,
    display: ratioValue(stream.display_aspect_ratio) === undefined ? undefined : stream.display_aspect_ratio
  };
}

export async function probe(file: string): Promise<ProbeResult> {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-show_chapters",
    "-of", "json",
    file
  ]);
  const result = JSON.parse(stdout) as ProbeResult;
  if (!Array.isArray(result.streams) || result.streams.length === 0) {
    throw new Error("ffprobe returned no streams");
  }
  return result;
}

export function contentVideoStreams(result: ProbeResult): ProbeStream[] {
  return result.streams.filter((stream) =>
    stream.codec_type === "video" && stream.disposition?.attached_pic !== 1
  );
}

export function hdrReason(stream: ProbeStream): string | undefined {
  const transfer = stream.color_transfer?.toLowerCase();
  if (transfer === "smpte2084" || transfer === "arib-std-b67" || transfer === "pq" || transfer === "hlg") {
    return `HDR transfer ${stream.color_transfer}`;
  }

  const identifyingText = JSON.stringify({
    profile: stream.profile,
    codecTag: stream.codec_tag_string,
    tags: stream.tags,
    sideData: stream.side_data_list
  }).toLowerCase();

  const markers: Array<[RegExp, string]> = [
    [/(dolby vision|dovi|dvhe|dvh1)/, "Dolby Vision metadata"],
    [/(hdr10\+|hdr dynamic metadata|smpte2094)/, "HDR10+ metadata"],
    [/(mastering display|content light level)/, "HDR mastering metadata"]
  ];
  return markers.find(([pattern]) => pattern.test(identifyingText))?.[1];
}

export function eligibility(result: ProbeResult): { eligible: true; videoStream: ProbeStream } | { eligible: false; reason: string } {
  const videos = contentVideoStreams(result);
  if (videos.length !== 1) return { eligible: false, reason: `expected one video stream, found ${videos.length}` };
  const video = videos[0];
  if (video.codec_name !== "h264") return { eligible: false, reason: `video codec is ${video.codec_name ?? "unknown"}` };
  if (isStandardSquarePixelFrame(video)) {
    const target = targetAspectRatio(video);
    if (aspectRatioConflicts(video, target)) {
      return { eligible: false, reason: `standard-resolution video has suspicious aspect metadata (SAR ${video.sample_aspect_ratio ?? "unknown"}, DAR ${video.display_aspect_ratio ?? "unknown"})` };
    }
  }
  const reason = hdrReason(video);
  if (reason) return { eligible: false, reason };
  const unknownStream = result.streams.find((stream) =>
    !stream.codec_name || ["none", "unknown"].includes(stream.codec_name.toLowerCase())
  );
  if (unknownStream) {
    const type = unknownStream.codec_type ?? "unknown";
    return { eligible: false, reason: `${type} stream ${unknownStream.index} codec is unknown and cannot be preserved` };
  }
  const dimensionlessVideo = result.streams.find((stream) =>
    stream.codec_type === "video" && (!(stream.width && stream.width > 0) || !(stream.height && stream.height > 0))
  );
  if (dimensionlessVideo) {
    return { eligible: false, reason: `video stream ${dimensionlessVideo.index} dimensions are missing and cannot be preserved` };
  }
  return { eligible: true, videoStream: video };
}

function positiveDuration(value?: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function clockDuration(value?: string): number | undefined {
  const match = value?.match(/^(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)$/);
  if (!match) return undefined;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function taggedDurations(stream: ProbeStream): number[] {
  if (!stream.tags) return [];
  return Object.entries(stream.tags)
    .filter(([key]) => key.toUpperCase() === "DURATION" || key.toUpperCase().startsWith("DURATION-"))
    .map(([, value]) => clockDuration(value))
    .filter((value): value is number => value !== undefined);
}

function durationsAgree(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(2, Math.min(left, right) * 0.01);
}

export function mediaDuration(result: ProbeResult): number {
  const content = contentVideoStreams(result)[0];
  const timedStreams = result.streams.filter((stream) =>
    stream === content || stream.codec_type === "audio"
  );
  const candidates: number[] = [];
  const contentDuration = positiveDuration(content?.duration);
  if (contentDuration !== undefined) candidates.push(contentDuration);
  for (const stream of timedStreams) candidates.push(...taggedDurations(stream));
  for (const stream of timedStreams) {
    const duration = positiveDuration(stream.duration);
    if (duration !== undefined && stream !== content) candidates.push(duration);
  }
  const formatDuration = positiveDuration(result.format?.duration);
  if (formatDuration !== undefined) candidates.push(formatDuration);
  if (candidates.length === 0) return 0;

  let best = candidates[0];
  let bestSupport = 0;
  for (const candidate of candidates) {
    const support = candidates.filter((other) => durationsAgree(candidate, other)).length;
    if (support > bestSupport) {
      best = candidate;
      bestSupport = support;
    }
  }
  return best;
}

export function frameRate(value?: string): number | undefined {
  if (!value) return undefined;
  const [numerator, denominator = 1] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  return numerator / denominator;
}

function ratesClose(left: number, right: number): boolean {
  return Math.abs(left - right) / Math.max(left, right) < 0.005;
}

function frameRateLabel(stream: ProbeStream): string {
  return `average ${stream.avg_frame_rate ?? "unknown"}, nominal ${stream.r_frame_rate ?? "unknown"}`;
}

function cadenceMatches(input: ProbeStream, output: ProbeStream): boolean {
  const inputAverage = frameRate(input.avg_frame_rate);
  const outputAverage = frameRate(output.avg_frame_rate);
  const inputNominal = frameRate(input.r_frame_rate);
  const outputNominal = frameRate(output.r_frame_rate);
  if (inputAverage === undefined && inputNominal === undefined) return true;
  if (inputAverage !== undefined && outputAverage !== undefined && ratesClose(inputAverage, outputAverage)) return true;
  if (inputNominal !== undefined && outputNominal !== undefined && ratesClose(inputNominal, outputNominal)) return true;
  if (inputNominal === undefined || outputNominal === undefined) return false;

  const higher = Math.max(inputNominal, outputNominal);
  const lower = Math.min(inputNominal, outputNominal);
  if (!ratesClose(higher, lower * 2)) return false;
  const averages = [inputAverage, outputAverage].filter((rate): rate is number => rate !== undefined);
  const supportsLowerRate = averages.some((rate) => ratesClose(rate, lower));
  const supportsHigherRate = averages.some((rate) => ratesClose(rate, higher));
  return supportsLowerRate && !supportsHigherRate;
}

export function validateTranscode(input: ProbeResult, output: ProbeResult): string[] {
  const errors: string[] = [];
  const inputVideo = contentVideoStreams(input)[0];
  const inputVideos = input.streams.filter((stream) => stream.codec_type === "video");
  const outputVideos = output.streams.filter((stream) => stream.codec_type === "video");
  const outputVideo = inputVideo
    ? outputVideos.find((stream) => stream.index === inputVideo.index)
    : undefined;
  if (!outputVideo || outputVideo.codec_name !== "hevc") {
    errors.push("output must contain exactly one HEVC content video stream");
  }
  if (inputVideos.length !== outputVideos.length) {
    errors.push(`video stream count changed (${inputVideos.length} to ${outputVideos.length})`);
  }
  for (const inputExtra of inputVideos.filter((stream) => stream.index !== inputVideo?.index)) {
    const outputExtra = outputVideos.find((stream) => stream.index === inputExtra.index);
    if (!outputExtra || outputExtra.codec_name !== inputExtra.codec_name) {
      errors.push(`video stream ${inputExtra.index} codec changed (${inputExtra.codec_name} to ${outputExtra?.codec_name ?? "missing"})`);
    }
  }

  if (inputVideo && outputVideo) {
    if (inputVideo.width !== outputVideo.width || inputVideo.height !== outputVideo.height) {
      errors.push(`video dimensions changed (${inputVideo.width}x${inputVideo.height} to ${outputVideo.width}x${outputVideo.height})`);
    }
    const expectedAspect = targetAspectRatio(inputVideo);
    if (expectedAspect.sample && !ratiosEqual(expectedAspect.sample, outputVideo.sample_aspect_ratio)) {
      errors.push(`sample aspect ratio is incorrect (expected ${expectedAspect.sample}, got ${outputVideo.sample_aspect_ratio ?? "unknown"})`);
    }
    if (expectedAspect.display && !ratiosEqual(expectedAspect.display, outputVideo.display_aspect_ratio)) {
      errors.push(`display aspect ratio is incorrect (expected ${expectedAspect.display}, got ${outputVideo.display_aspect_ratio ?? "unknown"})`);
    }

    if (!cadenceMatches(inputVideo, outputVideo)) {
      errors.push(`frame rate changed (${frameRateLabel(inputVideo)} to ${frameRateLabel(outputVideo)})`);
    }
    for (const field of ["color_primaries", "color_transfer", "color_space"] as const) {
      if (inputVideo[field] && inputVideo[field] !== outputVideo[field]) {
        errors.push(`${field} changed (${inputVideo[field]} to ${outputVideo[field] ?? "unknown"})`);
      }
    }
  }

  for (const type of ["audio", "subtitle", "attachment"] as const) {
    const before = input.streams.filter((stream) => stream.codec_type === type);
    const after = output.streams.filter((stream) => stream.codec_type === type);
    if (before.length !== after.length) errors.push(`${type} stream count changed (${before.length} to ${after.length})`);
    for (let i = 0; i < Math.min(before.length, after.length); i += 1) {
      if (before[i].codec_name !== after[i].codec_name) {
        errors.push(`${type} stream ${i} codec changed (${before[i].codec_name} to ${after[i].codec_name})`);
      }
    }
  }

  if ((input.chapters?.length ?? 0) !== (output.chapters?.length ?? 0)) errors.push("chapter count changed");
  const inputDuration = mediaDuration(input);
  const outputDuration = mediaDuration(output);
  const inputFormatDuration = positiveDuration(input.format?.duration);
  const outputFormatDuration = positiveDuration(output.format?.duration);
  const selectedDurationsMatch = inputDuration > 0 && outputDuration > 0 && durationsAgree(inputDuration, outputDuration);
  const formatDurationsMatch = inputFormatDuration !== undefined
    && outputFormatDuration !== undefined
    && durationsAgree(inputFormatDuration, outputFormatDuration);
  if ((inputDuration <= 0 && inputFormatDuration === undefined) || (outputDuration <= 0 && outputFormatDuration === undefined)) {
    errors.push("duration is missing or zero");
  } else if (!selectedDurationsMatch && !formatDurationsMatch) {
    errors.push(`duration changed from ${inputDuration.toFixed(2)}s to ${outputDuration.toFixed(2)}s`);
  }
  return errors;
}
