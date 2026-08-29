import { stat } from "node:fs/promises";
import { log, quote } from "./logger.js";
import { aspectRatioMatches, contentVideoStreams, isStandardSquarePixelFrame, probe, targetAspectRatio } from "./probe.js";
import { scan } from "./scan.js";
import { ProbeStream } from "./types.js";

export interface AspectAuditResult {
  mediaFiles: number;
  checkedHevcFiles: number;
  suspectFiles: string[];
  errors: number;
}

export function aspectIssue(stream: ProbeStream): string | undefined {
  if (stream.codec_name !== "hevc" || !isStandardSquarePixelFrame(stream)) return undefined;
  const target = targetAspectRatio(stream);
  if (aspectRatioMatches(stream, target)) return undefined;
  return `SAR ${stream.sample_aspect_ratio ?? "unknown"}, DAR ${stream.display_aspect_ratio ?? "unknown"}; expected SAR ${target.sample}, DAR ${target.display}`;
}

async function collectMediaFiles(roots: string[]): Promise<Set<string>> {
  const files = new Set<string>();
  for (const root of roots) {
    const info = await stat(root);
    if (info.isFile()) files.add(root);
    else if (info.isDirectory()) {
      for await (const file of scan(root)) files.add(file);
    } else {
      throw new Error(`not a regular file or directory: ${root}`);
    }
  }
  return files;
}

export async function auditAspectRatios(roots: string[]): Promise<AspectAuditResult> {
  const files = await collectMediaFiles(roots);
  const result: AspectAuditResult = { mediaFiles: files.size, checkedHevcFiles: 0, suspectFiles: [], errors: 0 };

  for (const file of [...files].sort()) {
    try {
      const media = await probe(file);
      const videos = contentVideoStreams(media);
      if (videos.length !== 1 || videos[0].codec_name !== "hevc" || !isStandardSquarePixelFrame(videos[0])) continue;
      result.checkedHevcFiles += 1;
      const issue = aspectIssue(videos[0]);
      if (!issue) continue;
      result.suspectFiles.push(file);
      log("AUDIT", `⚠️ Malformed aspect metadata. ${issue} ${quote(file)}`);
    } catch (error) {
      result.errors += 1;
      log("ERROR", `Aspect audit could not inspect file: ${String(error)} ${quote(file)}`);
    }
  }

  log("AUDIT", `Checked ${result.checkedHevcFiles} standard-frame HEVC file${result.checkedHevcFiles === 1 ? "" : "s"}. Found ${result.suspectFiles.length} with malformed aspect metadata.`);
  return result;
}
