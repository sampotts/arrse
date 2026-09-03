import { quote } from "./logger.js";

export interface ProgressMilestone {
  percent: number;
  etaSeconds: number;
  speed?: number;
}

export function formatProgressMessage(percent: number, etaSeconds: number, source: string): string {
  if (percent === 100) return `Done! ${quote(source)}`;
  return `${percent}% (ETA ${formatDuration(etaSeconds)}) ${quote(source)}`;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)}${units[unit]}`;
}

export function formatSkippedResult(savingsPercent: number, minimumPercent: number, source: string): string {
  const result = savingsPercent < 0
    ? `Output was ${Math.abs(savingsPercent).toFixed(2)}% larger than the source`
    : `Output saved ${savingsPercent.toFixed(2)}%`;
  return `⚠️ ${result}; minimum saving is ${minimumPercent}%. ${quote(source)}`;
}

export function formatSavedResult(savingsPercent: number, sourceBytes: number, outputBytes: number, source: string): string {
  return `✅ Success. Saved ${savingsPercent.toFixed(2)}% (${formatBytes(sourceBytes)} → ${formatBytes(outputBytes)}) ${quote(source)}`;
}

export function formatSavingsDetail(savingsPercent: number): string {
  return savingsPercent < 0
    ? `${Math.abs(savingsPercent).toFixed(2)}% larger`
    : `${savingsPercent.toFixed(2)}% savings`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

export function createMilestoneProgress(
  totalSeconds: number,
  onMilestone: (milestone: ProgressMilestone) => void,
  now: () => number = Date.now,
  framesPerSecond?: number
): (chunk: string) => void {
  const thresholds = [25, 50, 75, 100];
  const startedAt = now();
  let nextThreshold = 0;
  let buffer = "";
  let outputSeconds = 0;
  let encodedFrames = 0;
  let speed: number | undefined;

  const report = (finished: boolean) => {
    if (!(totalSeconds > 0)) return;
    const videoSeconds = framesPerSecond && framesPerSecond > 0 ? encodedFrames / framesPerSecond : outputSeconds;
    const calculatedPercent = Math.min(100, (videoSeconds / totalSeconds) * 100);
    const actualPercent = finished && calculatedPercent >= 98 ? 100 : calculatedPercent;
    while (nextThreshold < thresholds.length && actualPercent >= thresholds[nextThreshold]) {
      const percent = thresholds[nextThreshold++];
      const elapsedSeconds = Math.max(0.001, (now() - startedAt) / 1000);
      const measuredSpeed = framesPerSecond && framesPerSecond > 0 ? videoSeconds / elapsedSeconds : speed && speed > 0 ? speed : outputSeconds / elapsedSeconds;
      const etaSeconds = percent === 100 || !(measuredSpeed > 0)
        ? 0
        : Math.max(0, (totalSeconds - videoSeconds) / measuredSpeed);
      onMilestone({ percent, etaSeconds, speed: measuredSpeed > 0 ? measuredSpeed : undefined });
    }
  };

  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const separator = line.indexOf("=");
      if (separator < 0) continue;
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1);
      if (key === "out_time_us") {
        const microseconds = Number(value);
        if (Number.isFinite(microseconds)) outputSeconds = microseconds / 1_000_000;
      } else if (key === "frame") {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) encodedFrames = parsed;
      } else if (key === "speed") {
        const parsed = Number.parseFloat(value.replace(/x$/, ""));
        if (Number.isFinite(parsed) && parsed > 0) speed = parsed;
      } else if (key === "progress") {
        report(value === "end");
      }
    }
  };
}
