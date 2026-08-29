import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { log, quote } from "./logger.js";
import { contentVideoStreams, frameRate, mediaDuration, probe, validateTranscode } from "./probe.js";
import { run } from "./process.js";
import { createMilestoneProgress, formatBytes, formatProgressMessage } from "./progress.js";
import { safelyReplace } from "./replace.js";
import { ProbeResult, ProbeStream } from "./types.js";

export interface PillarboxGeometry {
  expectedWidth: number;
  expectedHeight: number;
  cropLeft: number;
  cropRight: number;
  sampleAspectRatio: string;
  timestamp?: string;
  quality?: number;
  device?: string;
}

export interface HorizontalBounds {
  left: number;
  right: number;
  activeWidth: number;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a || 1;
}

function ratio(value: string): [number, number] {
  const [numerator, denominator] = value.split(/[:/]/).map(Number);
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || numerator <= 0 || denominator <= 0) {
    throw new Error(`invalid sample aspect ratio: ${value}`);
  }
  return [numerator, denominator];
}

function reducedRatio(numerator: number, denominator: number): string {
  const divisor = greatestCommonDivisor(numerator, denominator);
  return `${numerator / divisor}:${denominator / divisor}`;
}

export function pillarboxTargets(geometry: PillarboxGeometry): { activeWidth: number; displayAspect: string; muxAspect: string } {
  const activeWidth = geometry.expectedWidth - geometry.cropLeft - geometry.cropRight;
  if (activeWidth <= 0) throw new Error("pillarbox crop removes the entire frame");
  const [sarNumerator, sarDenominator] = ratio(geometry.sampleAspectRatio);
  return {
    activeWidth,
    displayAspect: reducedRatio(activeWidth * sarNumerator, geometry.expectedHeight * sarDenominator),
    // FFmpeg calculates container SAR before the HEVC bitstream filter changes
    // the visible dimensions, so target DAR is based on the coded frame here.
    muxAspect: reducedRatio(geometry.expectedWidth * sarNumerator, geometry.expectedHeight * sarDenominator)
  };
}

export function pillarboxInputState(video: ProbeStream, geometry: PillarboxGeometry): "needs-crop" | "metadata-cropped" | "repaired" | "unsupported" {
  const target = pillarboxTargets(geometry);
  if (video.width === geometry.expectedWidth && video.height === geometry.expectedHeight) return "needs-crop";
  if (video.width !== target.activeWidth || video.height !== geometry.expectedHeight) return "unsupported";
  if (video.coded_width === geometry.expectedWidth) return "metadata-cropped";
  if (video.coded_width !== undefined) return "repaired";
  return "unsupported";
}

export function detectHorizontalBounds(frame: Uint8Array, width: number, height: number): HorizontalBounds {
  if (frame.length < width * height) throw new Error("decoded frame is incomplete");
  const activeColumn = (x: number): boolean => {
    let visiblePixels = 0;
    for (let y = 0; y < height; y += 1) {
      if (frame[y * width + x] > 24) visiblePixels += 1;
    }
    return visiblePixels > height * 0.05;
  };
  let left = 0;
  let right = width - 1;
  while (left < width && !activeColumn(left)) left += 1;
  while (right >= 0 && !activeColumn(right)) right -= 1;
  if (left > right) throw new Error("decoded sample frame contains no visible picture");
  return { left, right, activeWidth: right - left + 1 };
}

async function sampleFrame(source: string, timestamp: string, width: number, height: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner", "-nostdin", "-v", "error",
      "-ss", timestamp, "-i", source,
      "-frames:v", "1", "-an", "-sn",
      "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    let errors = "";
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`ffmpeg sample decode exited with ${code}: ${errors.trim()}`));
      else {
        const frame = Buffer.concat(output);
        if (frame.length < width * height) reject(new Error(`sample decode returned ${frame.length} bytes, expected ${width * height}`));
        else resolve(frame.subarray(0, width * height));
      }
    });
  });
}

export function pillarboxRepairArgs(
  source: string,
  output: string,
  videoIndex: number,
  geometry: PillarboxGeometry,
  inputAlreadyCropped = false
): string[] {
  const target = pillarboxTargets(geometry);
  const filters = [
    ...(!inputAlreadyCropped ? [`crop=${target.activeWidth}:${geometry.expectedHeight}:${geometry.cropLeft}:0`] : []),
    `setsar=${geometry.sampleAspectRatio.replace(":", "/")}`,
    "format=nv12",
    "hwupload"
  ].join(",");
  return [
    "-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-nostats", "-progress", "pipe:1",
    "-vaapi_device", geometry.device ?? process.env.INTEL_DEVICE ?? "/dev/dri/renderD128",
    "-i", source,
    "-map", "0", "-map_metadata", "0", "-map_chapters", "0",
    "-c", "copy",
    `-filter:${videoIndex}`, filters,
    `-c:${videoIndex}`, "hevc_vaapi",
    `-low_power:${videoIndex}`, "1",
    `-rc_mode:${videoIndex}`, "CQP",
    `-qp:${videoIndex}`, String(geometry.quality ?? 16),
    `-aspect:${videoIndex}`, target.displayAspect,
    "-max_muxing_queue_size", "4096",
    ...(path.extname(output).toLowerCase() === ".m4v" ? ["-f", "mp4"] : []),
    output
  ];
}

function expectedProbe(input: ProbeResult, videoIndex: number, geometry: PillarboxGeometry): ProbeResult {
  const expected = structuredClone(input);
  const video = expected.streams.find((stream) => stream.index === videoIndex);
  if (!video) throw new Error("content video stream disappeared from expected probe");
  const target = pillarboxTargets(geometry);
  video.width = target.activeWidth;
  video.height = geometry.expectedHeight;
  video.sample_aspect_ratio = geometry.sampleAspectRatio;
  video.display_aspect_ratio = target.displayAspect;
  return expected;
}

async function removeIfPresent(file: string): Promise<void> {
  try { await unlink(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function repairPillarbox(source: string, geometry: PillarboxGeometry, cacheDir = process.env.CACHE_DIR ?? "/cache"): Promise<void> {
  const input = await probe(source);
  const videos = contentVideoStreams(input);
  if (videos.length !== 1) throw new Error(`expected one content video stream, found ${videos.length}`);
  const video = videos[0];
  if (video.codec_name !== "hevc") throw new Error(`video codec is ${video.codec_name ?? "unknown"}, not HEVC`);
  if (geometry.cropLeft % 2 !== 0 || geometry.cropRight % 2 !== 0) throw new Error("4:2:0 HEVC crop offsets must be even");
  const target = pillarboxTargets(geometry);
  const inputState = pillarboxInputState(video, geometry);
  if (inputState === "repaired") {
    throw new Error(`video is already physically repaired at ${video.width}x${video.height}`);
  }
  const inputAlreadyCropped = inputState === "metadata-cropped";
  const inputNeedsCrop = inputState === "needs-crop";
  if (inputState === "unsupported") {
    throw new Error(`visible dimensions are ${video.width}x${video.height}; expected ${geometry.expectedWidth}x${geometry.expectedHeight} or ${target.activeWidth}x${geometry.expectedHeight}`);
  }

  const sampleWidth = inputAlreadyCropped ? target.activeWidth : geometry.expectedWidth;
  const frame = await sampleFrame(source, geometry.timestamp ?? "00:10:00", sampleWidth, geometry.expectedHeight);
  const detected = detectHorizontalBounds(frame, sampleWidth, geometry.expectedHeight);
  const expectedLeft = inputAlreadyCropped ? 0 : geometry.cropLeft;
  const expectedRight = inputAlreadyCropped ? target.activeWidth - 1 : geometry.expectedWidth - geometry.cropRight - 1;
  if (Math.abs(detected.left - expectedLeft) > 8 || Math.abs(detected.right - expectedRight) > 8) {
    throw new Error(`sample frame picture is x=${detected.left}..${detected.right}, expected approximately x=${expectedLeft}..${expectedRight}`);
  }

  await mkdir(cacheDir, { recursive: true });
  const sourceStat = await stat(source);
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const cacheOutput = path.join(cacheDir, `${digest}-${randomUUID()}${path.extname(source)}`);
  const expected = expectedProbe(input, video.index, geometry);
  try {
    log("TRANSCODE", `Starting high-quality Intel hardware pillarbox repair at QP ${geometry.quality ?? 16} ${quote(source)}`);
    const reportProgress = createMilestoneProgress(mediaDuration(input), ({ percent, etaSeconds }) => {
      log("PROGRESS", formatProgressMessage(percent, etaSeconds, source));
    }, undefined, frameRate(video.avg_frame_rate));
    await run("ffmpeg", pillarboxRepairArgs(source, cacheOutput, video.index, geometry, inputAlreadyCropped), undefined, reportProgress);
    const output = await probe(cacheOutput);
    const validationErrors = validateTranscode(expected, output);
    if (validationErrors.length > 0) throw new Error(validationErrors.join("; "));
    log("VALIDATE", `Validation complete ${quote(source)}`);
    const current = await stat(source);
    if (current.size !== sourceStat.size || Math.trunc(current.mtimeMs) !== Math.trunc(sourceStat.mtimeMs)) {
      throw new Error("source changed while pillarbox repair was running");
    }
    await safelyReplace(source, cacheOutput, expected);
    const outputStat = await stat(source);
    log("SAVED", `✅ Pillarbox repaired. ${formatBytes(sourceStat.size)} → ${formatBytes(outputStat.size)}. Visible ${target.activeWidth}x${geometry.expectedHeight}, DAR ${target.displayAspect} ${quote(source)}`);
  } finally {
    await removeIfPresent(cacheOutput).catch((error) => log("ERROR", `Could not clean pillarbox repair output: ${String(error)} ${quote(cacheOutput)}`));
  }
}
