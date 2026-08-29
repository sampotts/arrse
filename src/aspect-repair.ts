import { createHash, randomUUID } from "node:crypto";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { log, quote } from "./logger.js";
import { aspectRatioMatches, contentVideoStreams, isStandardSquarePixelFrame, probe, targetAspectRatio, validateTranscode } from "./probe.js";
import { run } from "./process.js";
import { safelyReplace } from "./replace.js";

export type RepairRunner = typeof run;

async function removeIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function aspectRepairArgs(source: string, output: string, videoOrdinal: number, displayAspect: string): string[] {
  return [
    "-hide_banner", "-nostdin", "-y", "-v", "error",
    "-i", source,
    "-map", "0",
    "-map_metadata", "0",
    "-map_chapters", "0",
    "-c", "copy",
    `-bsf:v:${videoOrdinal}`, "hevc_metadata=sample_aspect_ratio=1/1",
    `-aspect:v:${videoOrdinal}`, displayAspect,
    "-max_muxing_queue_size", "4096",
    ...(path.extname(output).toLowerCase() === ".m4v" ? ["-f", "mp4"] : []),
    output
  ];
}

export async function repairAspectRatio(source: string, cacheDir = process.env.CACHE_DIR ?? "/cache", runner: RepairRunner = run): Promise<boolean> {
  const input = await probe(source);
  const contentVideos = contentVideoStreams(input);
  if (contentVideos.length !== 1) throw new Error(`expected one content video stream, found ${contentVideos.length}`);
  const video = contentVideos[0];
  if (video.codec_name !== "hevc") throw new Error(`video codec is ${video.codec_name ?? "unknown"}, not HEVC`);
  if (!isStandardSquarePixelFrame(video)) {
    throw new Error(`automatic aspect repair is limited to standard square-pixel frame dimensions, got ${video.width}x${video.height}`);
  }

  const target = targetAspectRatio(video);
  if (!target.display) throw new Error("could not calculate the target display aspect ratio");
  if (aspectRatioMatches(video, target)) {
    log("SKIP", `Aspect ratio is already correct ${quote(source)}`);
    return false;
  }

  await mkdir(cacheDir, { recursive: true });
  const sourceStat = await stat(source);
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const cacheOutput = path.join(cacheDir, `${digest}-${randomUUID()}${path.extname(source)}`);
  const videoOrdinal = input.streams.filter((stream) => stream.codec_type === "video").indexOf(video);
  try {
    await runner("ffmpeg", aspectRepairArgs(source, cacheOutput, videoOrdinal, target.display));
    const output = await probe(cacheOutput);
    const validationErrors = validateTranscode(input, output);
    if (validationErrors.length > 0) throw new Error(validationErrors.join("; "));
    const currentSourceStat = await stat(source);
    if (currentSourceStat.size !== sourceStat.size || Math.trunc(currentSourceStat.mtimeMs) !== Math.trunc(sourceStat.mtimeMs)) {
      throw new Error("source changed while aspect repair was running");
    }
    await safelyReplace(source, cacheOutput, input);
    log("SAVED", `✅ Aspect ratio repaired to SAR ${target.sample} / DAR ${target.display} ${quote(source)}`);
    return true;
  } finally {
    await removeIfPresent(cacheOutput).catch((error) => log("ERROR", `Could not clean aspect repair output: ${String(error)} ${quote(cacheOutput)}`));
  }
}
