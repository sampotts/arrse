import { createHash, randomUUID } from "node:crypto";
import { mkdir, opendir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { notifyArr } from "./arr.js";
import { log } from "./logger.js";
import { eligibility, mediaDuration, probe, validateTranscode } from "./probe.js";
import { createMilestoneProgress, formatDuration } from "./progress.js";
import { run } from "./process.js";
import { safelyReplace } from "./replace.js";
import { scan } from "./scan.js";
import { StateStore } from "./state.js";
import { Config, HardwareEncoder } from "./types.js";

export type Runner = typeof run;

const CACHE_OUTPUT_PATTERN = /^[a-f0-9]{16}-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:mkv|mp4|m4v|mov|ts|m2ts)$/i;

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

export function qsvSelfTestArgs(config: Config): string[] {
  return [
    "-hide_banner", "-nostdin", "-v", "error",
    "-init_hw_device", `qsv=qs:${config.qsvDevice}`,
    "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=24",
    "-frames:v", "1", "-an",
    "-c:v", "hevc_qsv",
    "-q:v", String(config.qsvQuality),
    "-low_power:v", "0",
    "-f", "null", "-"
  ];
}

export async function verifyQsv(config: Config, runner: Runner = run, signal?: AbortSignal): Promise<void> {
  await runner("ffmpeg", qsvSelfTestArgs(config), signal);
}

export function vaapiSelfTestArgs(config: Config): string[] {
  return [
    "-hide_banner", "-nostdin", "-v", "error",
    "-vaapi_device", config.qsvDevice,
    "-f", "lavfi", "-i", "color=c=black:s=1280x720:r=24",
    "-frames:v", "1", "-an",
    "-vf", "format=nv12,hwupload",
    "-c:v", "hevc_vaapi",
    "-qp:v", String(config.qsvQuality),
    "-f", "null", "-"
  ];
}

export async function verifyVaapi(config: Config, runner: Runner = run, signal?: AbortSignal): Promise<void> {
  await runner("ffmpeg", vaapiSelfTestArgs(config), signal);
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
  encoder: HardwareEncoder = "qsv"
): string[] {
  const deviceArgs = encoder === "qsv"
    ? ["-init_hw_device", `qsv=qs:${config.qsvDevice}`]
    : [
        "-vaapi_device", config.qsvDevice,
        "-hwaccel", "vaapi",
        "-hwaccel_device", config.qsvDevice,
        "-hwaccel_output_format", "vaapi"
      ];
  const encoderArgs = encoder === "qsv"
    ? [
        `-c:${videoStreamIndex}`, "hevc_qsv",
        `-q:${videoStreamIndex}`, String(config.qsvQuality),
        `-preset:${videoStreamIndex}`, config.qsvPreset,
        `-low_power:${videoStreamIndex}`, "0"
      ]
    : [
        `-c:${videoStreamIndex}`, "hevc_vaapi",
        `-qp:${videoStreamIndex}`, String(config.qsvQuality)
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
    ...encoderArgs,
    "-max_muxing_queue_size", "4096",
    output
  ];
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
      log("SKIP", "file already has an active job", { file: source });
      return;
    }
    this.active.add(source);
    let cacheOutput: string | undefined;
    try {
      const sourceStat = await stat(source);
      if (this.state.isCurrent(source, sourceStat.size, sourceStat.mtimeMs)) {
        log("SKIP", "unchanged file already processed", { file: source });
        return;
      }
      const input = await probe(source);
      const check = eligibility(input);
      if (!check.eligible) {
        log("SKIP", check.reason, { file: source });
        return;
      }
      if (this.config.dryRun) {
        log("TRANSCODE", "dry run: eligible H.264 SDR file", { file: source });
        await this.state.record(source, "dry-run");
        return;
      }

      const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
      cacheOutput = path.join(this.config.cacheDir, `${digest}-${randomUUID()}${path.extname(source)}`);
      log("TRANSCODE", "starting Intel hardware HEVC transcode", { file: source, output: cacheOutput, encoder: this.encoder });
      const reportProgress = createMilestoneProgress(mediaDuration(input), ({ percent, etaSeconds, speed }) => {
        log("PROGRESS", `transcode ${percent}% complete`, {
          file: source,
          percent,
          speed: speed ? `${speed.toFixed(2)}x` : "unknown",
          eta: formatDuration(etaSeconds)
        });
      });
      await this.runner("ffmpeg", ffmpegArgs(source, cacheOutput, check.videoStream.index, this.config, this.encoder), this.signal, reportProgress);

      if (this.signal?.aborted) throw this.signal.reason;

      log("VALIDATE", "validating cached output with ffprobe", { file: source });
      const output = await probe(cacheOutput);
      const validationErrors = validateTranscode(input, output);
      if (validationErrors.length > 0) throw new Error(validationErrors.join("; "));

      const outputStat = await stat(cacheOutput);
      const savingsPercent = ((sourceStat.size - outputStat.size) / sourceStat.size) * 100;
      if (savingsPercent < this.config.minSavingsPercent) {
        log("SKIP", "output did not meet minimum savings", { file: source, savingsPercent: Number(savingsPercent.toFixed(2)) });
        await this.state.record(source, "not-smaller", `${savingsPercent.toFixed(2)}% savings`);
        return;
      }

      const currentSourceStat = await stat(source);
      if (currentSourceStat.size !== sourceStat.size || Math.trunc(currentSourceStat.mtimeMs) !== Math.trunc(sourceStat.mtimeMs)) {
        throw new Error("source changed while transcode was running");
      }
      await safelyReplace(source, cacheOutput, input);
      await this.state.record(source, "saved", `${savingsPercent.toFixed(2)}% savings`);
      log("SAVED", "source replaced safely", {
        file: source,
        savingsPercent: Number(savingsPercent.toFixed(2)),
        bytesSaved: sourceStat.size - outputStat.size
      });
      try {
        await notifyArr(source, this.config.sonarr, this.config.radarr);
      } catch (error) {
        // Replacing the media succeeded. An automation API outage must not make
        // the already-HEVC file eligible for a replacement retry.
        log("ERROR", "Arr notification failed after successful replacement", { file: source, error: String(error) });
      }
    } catch (error) {
      if (this.signal?.aborted) {
        log("INFO", "transcode cancelled during shutdown; original left in place", { file: source });
      } else {
        log("ERROR", "job failed; original was left in place unless SAVED was already logged", { file: source, error: String(error) });
        try { await this.state.record(source, "error", String(error)); } catch { /* The source may have been renamed by Arr. */ }
      }
    } finally {
      if (cacheOutput) await removeIfPresent(cacheOutput).catch((error) => log("ERROR", "could not clean cache output", { file: cacheOutput, error: String(error) }));
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
        log("ERROR", "media root scan failed", { root, error: String(error) });
      }
    }
    const queue = [...files].sort();
    log("SCAN", "scan complete", { files: queue.length, workers: this.config.workers });

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
