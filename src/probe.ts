import { run } from "./process.js";
import { ProbeResult, ProbeStream } from "./types.js";

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
  const reason = hdrReason(video);
  if (reason) return { eligible: false, reason };
  return { eligible: true, videoStream: video };
}

function duration(result: ProbeResult): number {
  const formatDuration = Number(result.format?.duration);
  if (Number.isFinite(formatDuration)) return formatDuration;
  return Math.max(0, ...result.streams.map((stream) => Number(stream.duration) || 0));
}

export function validateTranscode(input: ProbeResult, output: ProbeResult): string[] {
  const errors: string[] = [];
  const outputVideos = contentVideoStreams(output);
  if (outputVideos.length !== 1 || outputVideos[0].codec_name !== "hevc") {
    errors.push("output must contain exactly one HEVC content video stream");
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
  const inputDuration = duration(input);
  const outputDuration = duration(output);
  if (inputDuration <= 0 || outputDuration <= 0) errors.push("duration is missing or zero");
  else if (Math.abs(inputDuration - outputDuration) > Math.max(2, inputDuration * 0.01)) {
    errors.push(`duration changed from ${inputDuration.toFixed(2)}s to ${outputDuration.toFixed(2)}s`);
  }
  return errors;
}
