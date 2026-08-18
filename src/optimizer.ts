import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { notifyArr } from "./arr.js";
import { log } from "./logger.js";
import { eligibility, probe, validateTranscode } from "./probe.js";
import { run } from "./process.js";
import { safelyReplace } from "./replace.js";
import { scan } from "./scan.js";
import { StateStore } from "./state.js";
import { Config } from "./types.js";

export type Runner = typeof run;

async function removeIfPresent(file: string): Promise<void> {
  try { await unlink(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function ffmpegArgs(source: string, output: string, videoStreamIndex: number, config: Config): string[] {
  return [
    "-hide_banner", "-nostdin", "-y",
    "-init_hw_device", `qsv=qs:${config.qsvDevice}`,
    "-filter_hw_device", "qs",
    "-hwaccel", "qsv",
    "-hwaccel_output_format", "qsv",
    "-i", source,
    "-map", "0",
    "-map_metadata", "0",
    "-map_chapters", "0",
    "-c", "copy",
    `-c:${videoStreamIndex}`, "hevc_qsv",
    `-global_quality:${videoStreamIndex}`, String(config.qsvQuality),
    `-preset:${videoStreamIndex}`, config.qsvPreset,
    "-max_muxing_queue_size", "4096",
    output
  ];
}

export class Optimizer {
  private readonly active = new Set<string>();

  constructor(private readonly config: Config, private readonly state: StateStore, private readonly runner: Runner = run) {}

  async processFile(source: string): Promise<void> {
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
      log("TRANSCODE", "starting Intel QSV HEVC transcode", { file: source, output: cacheOutput });
      await this.runner("ffmpeg", ffmpegArgs(source, cacheOutput, check.videoStream.index, this.config));

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
      log("ERROR", "job failed; original was left in place unless SAVED was already logged", { file: source, error: String(error) });
      try { await this.state.record(source, "error", String(error)); } catch { /* The source may have been renamed by Arr. */ }
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
      while (next < queue.length) {
        const index = next++;
        await this.processFile(queue[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.config.workers, queue.length) }, worker));
  }
}
