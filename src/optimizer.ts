import { createHash, randomUUID } from "node:crypto";
import { mkdir, opendir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { notifyArr } from "./arr.js";
import { log, quote } from "./logger.js";
import { eligibility, frameRate, mediaDuration, probe, validateTranscode } from "./probe.js";
import { createMilestoneProgress, formatProgressMessage, formatSavedResult, formatSavingsDetail, formatSkippedResult } from "./progress.js";
import { run } from "./process.js";
import { safelyReplace } from "./replace.js";
import { scan } from "./scan.js";
import { StateStore } from "./state.js";
import { Config, HardwareEncoder } from "./types.js";

export type Runner = typeof run;

const CACHE_OUTPUT_PATTERN = /^[a-f0-9]{16}-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:mkv|mp4|m4v|mov|ts|m2ts)$/i;
const MIN_QVBR_VIDEO_BITRATE = 250_000;
const MUX_OVERHEAD_BITRATE = 32_000;
const ENCODING_PROFILE_VERSION = 2;

export async function cleanupOrphanedCacheFiles(cacheDir: string): Promise<number> {
  await mkdir(cacheDir, { recursive: true });
  const directory = await opendir(cacheDir);
  let removed = 0;
  for await (const entry of directory) {
    if (!entry.isFile() || !CACHE_OUTPUT_PATTERN.test(entry.name)) continue;
    await unlink(path.join(cacheDir, entry.name));
    removed += 1;
  }
  return removed;
}

function positiveNumber(value?: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function tagNumber(tags: Record<string, string> | undefined, prefix: string): number | undefined {
  if (!tags) return undefined;
  for (const [key, value] of Object.entries(tags)) {
    const normalized = key.toUpperCase();
    if (normalized === prefix || normalized.startsWith(`${prefix}-`)) {
      const parsed = positiveNumber(value);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

function fallbackAudioBitrate(codec?: string): number {
  switch (codec) {
    case "truehd":
    case "mlp":
      return 4_000_000;
    case "dts":
      return 1_536_000;
    case "flac":
      return 1_000_000;
    case "eac3":
      return 768_000;
    case "ac3":
      return 640_000;
    case "aac":
    case "opus":
      return 320_000;
    default:
      return 640_000;
  }
}

function streamBitrate(stream: import("./types.js").ProbeStream, duration: number): number {
  const reported = positiveNumber(stream.bit_rate) ?? tagNumber(stream.tags, "BPS");
  if (reported !== undefined) return reported;
  const bytes = tagNumber(stream.tags, "NUMBER_OF_BYTES");
  if (bytes !== undefined) return (bytes * 8) / duration;
  if (stream.codec_type === "audio") return fallbackAudioBitrate(stream.codec_name);
  if (stream.codec_type === "subtitle") return 16_000;
  if (stream.codec_type === "data") return 64_000;
  return 0;
}

export interface QvbrTarget {
  videoBitrate: number;
  sourceTotalBitrate: number;
  copiedBitrate: number;
}

export function calculateQvbrTarget(input: import("./types.js").ProbeResult, sourceSize: number, targetSavingsPercent: number): QvbrTarget | undefined {
  const duration = mediaDuration(input);
  if (!Number.isFinite(duration) || duration <= 0 || sourceSize <= 0) return undefined;

  const sourceTotalBitrate = (sourceSize * 8) / duration;
  const video = input.streams.find((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
  const reportedVideoBitrate = video ? positiveNumber(video.bit_rate) ?? tagNumber(video.tags, "BPS") : undefined;
  const estimatedCopiedBitrate = input.streams
    .filter((stream) => stream !== video)
    .reduce((total, stream) => total + streamBitrate(stream, duration), 0);
  const bitrateRemainder = reportedVideoBitrate === undefined ? 0 : Math.max(0, sourceTotalBitrate - reportedVideoBitrate);
  const copiedBitrate = Math.max(estimatedCopiedBitrate, bitrateRemainder);
  const targetTotalBitrate = sourceTotalBitrate * (1 - targetSavingsPercent / 100);
  const videoBitrate = Math.floor((targetTotalBitrate - copiedBitrate - MUX_OVERHEAD_BITRATE) / 1000) * 1000;
  if (videoBitrate < MIN_QVBR_VIDEO_BITRATE) return undefined;
  return { videoBitrate, sourceTotalBitrate, copiedBitrate };
}

export function vaapiQvbrSelfTestArgs(config: Config): string[] {
  return [
    "-hide_banner", "-nostdin", "-v", "error",
    "-vaapi_device", config.device,
    "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24",
    "-frames:v", "4", "-an",
    "-vf", "format=nv12,hwupload",
    "-c:v", "hevc_vaapi",
    "-low_power:v", "1",
    "-rc_mode:v", "QVBR",
    "-b:v", "5M",
    "-maxrate:v", "8M",
    "-bufsize:v", "10M",
    "-global_quality:v", String(config.quality),
    "-f", "null", "-"
  ];
}

export async function verifyVaapiQvbr(config: Config, runner: Runner = run, signal?: AbortSignal): Promise<void> {
  await runner("ffmpeg", vaapiQvbrSelfTestArgs(config), signal);
}

export function vaapiCqpSelfTestArgs(config: Config): string[] {
  return [
    "-hide_banner", "-nostdin", "-v", "error",
    "-vaapi_device", config.device,
    "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=24",
    "-frames:v", "1", "-an",
    "-vf", "format=nv12,hwupload",
    "-c:v", "hevc_vaapi",
    "-low_power:v", "1",
    "-rc_mode:v", "CQP",
    "-qp:v", String(config.quality),
    "-f", "null", "-"
  ];
}

export async function verifyVaapiCqp(config: Config, runner: Runner = run, signal?: AbortSignal): Promise<void> {
  await runner("ffmpeg", vaapiCqpSelfTestArgs(config), signal);
}

async function removeIfPresent(file: string): Promise<void> {
  try { await unlink(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function ffmpegArgs(
  source: string,
  output: string,
  videoStreamIndex: number,
  config: Config,
  encoder: HardwareEncoder = "vaapi-qvbr",
  targetVideoBitrate?: number,
  hardwareDecode = true
): string[] {
  if (encoder === "vaapi-qvbr" && targetVideoBitrate === undefined) {
    throw new Error("QVBR requires a target video bitrate");
  }
  const deviceArgs = [
    "-vaapi_device", config.device
  ];
  if (hardwareDecode) {
    deviceArgs.push("-hwaccel", "vaapi", "-hwaccel_device", config.device, "-hwaccel_output_format", "vaapi");
  }
  const filterArgs = hardwareDecode ? [] : [`-filter:${videoStreamIndex}`, "format=nv12,hwupload"];
  const encoderArgs = encoder === "vaapi-qvbr"
    ? [
        `-c:${videoStreamIndex}`, "hevc_vaapi",
        `-low_power:${videoStreamIndex}`, "1",
        `-rc_mode:${videoStreamIndex}`, "QVBR",
        `-b:${videoStreamIndex}`, String(targetVideoBitrate),
        `-maxrate:${videoStreamIndex}`, String(Math.ceil(targetVideoBitrate! * 1.6)),
        `-bufsize:${videoStreamIndex}`, String(targetVideoBitrate! * 2),
        `-global_quality:${videoStreamIndex}`, String(config.quality)
      ]
    : [
        `-c:${videoStreamIndex}`, "hevc_vaapi",
        `-low_power:${videoStreamIndex}`, "1",
        `-rc_mode:${videoStreamIndex}`, "CQP",
        `-qp:${videoStreamIndex}`, String(config.quality)
      ];
  return [
    "-hide_banner", "-nostdin", "-y",
    "-loglevel", "error", "-nostats",
    "-progress", "pipe:1",
    ...deviceArgs,
    "-i", source,
    "-map", "0",
    "-map_metadata", "0",
    "-map_chapters", "0",
    "-c", "copy",
    ...filterArgs,
    ...encoderArgs,
    "-max_muxing_queue_size", "4096",
    ...(path.extname(output).toLowerCase() === ".m4v" ? ["-f", "mp4"] : []),
    output
  ];
}

function shouldRetryWithSoftwareDecode(error: unknown): boolean {
  return /Error reinitializing filters|Impossible to convert|Function not implemented|output must contain exactly one HEVC content video stream|duration changed/i.test(String(error));
}

function encodingProfile(config: Config, encoder: HardwareEncoder): string {
  return `v${ENCODING_PROFILE_VERSION}:${encoder}:quality=${config.quality}:target=${config.targetSavingsPercent}:minimum=${config.minSavingsPercent}`;
}

function mbps(bitsPerSecond: number): string {
  return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`;
}

export class Optimizer {
  private readonly active = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly state: StateStore,
    private readonly encoder: HardwareEncoder,
    private readonly runner: Runner = run,
    private readonly signal?: AbortSignal
  ) {}

  async processFile(source: string): Promise<void> {
    if (this.signal?.aborted) return;
    if (this.active.has(source)) {
      log("SKIP", `File already has an active job ${quote(source)}`);
      return;
    }
    this.active.add(source);
    let cacheOutput: string | undefined;
    try {
      const profile = encodingProfile(this.config, this.encoder);
      const sourceStat = await stat(source);
      if (this.state.isCurrent(source, sourceStat.size, sourceStat.mtimeMs, profile)) {
        log("SKIP", `Unchanged file already processed ${quote(source)}`);
        return;
      }
      const input = await probe(source);
      const check = eligibility(input);
      if (!check.eligible) {
        const reason = check.reason.charAt(0).toUpperCase() + check.reason.slice(1);
        log("SKIP", `${reason} ${quote(source)}`);
        return;
      }
      if (this.config.dryRun) {
        log("TRANSCODE", `Dry run: eligible H.264 SDR file ${quote(source)}`);
        await this.state.record(source, "dry-run", undefined, profile);
        return;
      }

      const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
      cacheOutput = path.join(this.config.cacheDir, `${digest}-${randomUUID()}${path.extname(source)}`);
      const qvbrTarget = this.encoder === "vaapi-qvbr"
        ? calculateQvbrTarget(input, sourceStat.size, this.config.targetSavingsPercent)
        : undefined;
      if (this.encoder === "vaapi-qvbr" && !qvbrTarget) {
        log("SKIP", `Copied streams leave insufficient room for the ${this.config.targetSavingsPercent}% QVBR savings target ${quote(source)}`);
        await this.state.record(source, "not-smaller", "Insufficient bitrate available for QVBR target", profile);
        return;
      }
      const mode = this.encoder === "vaapi-qvbr" ? `VAAPI QVBR at ${mbps(qvbrTarget!.videoBitrate)}` : "VAAPI CQP";
      log("TRANSCODE", `Starting Intel hardware HEVC transcode using ${mode} ${quote(source)}`);
      const transcode = async (hardwareDecode: boolean) => {
        const reportProgress = createMilestoneProgress(mediaDuration(input), ({ percent, etaSeconds }) => {
          log("PROGRESS", formatProgressMessage(percent, etaSeconds, source));
        }, undefined, frameRate(check.videoStream.avg_frame_rate));
        await this.runner("ffmpeg", ffmpegArgs(source, cacheOutput!, check.videoStream.index, this.config, this.encoder, qvbrTarget?.videoBitrate, hardwareDecode), this.signal, reportProgress);
        if (this.signal?.aborted) throw this.signal.reason;
        const output = await probe(cacheOutput!);
        const validationErrors = validateTranscode(input, output);
        if (validationErrors.length > 0) throw new Error(validationErrors.join("; "));
      };
      try {
        await transcode(true);
      } catch (error) {
        if (this.signal?.aborted || !shouldRetryWithSoftwareDecode(error)) throw error;
        await removeIfPresent(cacheOutput);
        log("INFO", `Zero-copy attempt failed; retrying with software decode and Intel hardware encode. Reason: ${String(error)} ${quote(source)}`);
        await transcode(false);
      }

      if (this.signal?.aborted) throw this.signal.reason;

      log("VALIDATE", `Validation complete ${quote(source)}`);

      const outputStat = await stat(cacheOutput);
      const savingsPercent = ((sourceStat.size - outputStat.size) / sourceStat.size) * 100;
      if (savingsPercent < this.config.minSavingsPercent) {
        log("SKIP", formatSkippedResult(savingsPercent, this.config.minSavingsPercent, source));
        await this.state.record(source, "not-smaller", formatSavingsDetail(savingsPercent), profile);
        return;
      }

      const currentSourceStat = await stat(source);
      if (currentSourceStat.size !== sourceStat.size || Math.trunc(currentSourceStat.mtimeMs) !== Math.trunc(sourceStat.mtimeMs)) {
        throw new Error("source changed while transcode was running");
      }
      await safelyReplace(source, cacheOutput, input);
      await this.state.record(source, "saved", `${savingsPercent.toFixed(2)}% savings`, profile);
      log("SAVED", formatSavedResult(savingsPercent, sourceStat.size, outputStat.size, source));
      try {
        await notifyArr(source, this.config.sonarr, this.config.radarr);
      } catch (error) {
        // Replacing the media succeeded. An automation API outage must not make
        // the already-HEVC file eligible for a replacement retry.
        log("ERROR", `Arr notification failed after successful replacement: ${String(error)} ${quote(source)}`);
      }
    } catch (error) {
      if (this.signal?.aborted) {
        log("INFO", `Transcode cancelled during shutdown; original left in place ${quote(source)}`);
      } else {
        log("ERROR", `Job failed; original left in place: ${String(error)} ${quote(source)}`);
        try { await this.state.record(source, "error", String(error), encodingProfile(this.config, this.encoder)); } catch { /* The source may have been renamed by Arr. */ }
      }
    } finally {
      if (cacheOutput) await removeIfPresent(cacheOutput).catch((error) => log("ERROR", `Could not clean cache output: ${String(error)} ${quote(cacheOutput!)}`));
      this.active.delete(source);
    }
  }

  async scanOnce(): Promise<void> {
    await mkdir(this.config.cacheDir, { recursive: true });
    const files = new Set<string>();
    for (const root of this.config.inputPaths) {
      try {
        for await (const file of scan(root)) files.add(file);
      } catch (error) {
        log("ERROR", `Media root scan failed: ${String(error)} ${quote(root)}`);
      }
    }
    const queue = [...files].sort();
    log("SCAN", `Found ${queue.length} media file${queue.length === 1 ? "" : "s"} using ${this.config.workers} worker${this.config.workers === 1 ? "" : "s"}.`);

    let next = 0;
    const worker = async () => {
      while (!this.signal?.aborted && next < queue.length) {
        const index = next++;
        await this.processFile(queue[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.config.workers, queue.length) }, worker));
  }
}
