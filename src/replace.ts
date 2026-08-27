import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, chown, copyFile, open, rename, stat, unlink, utimes } from "node:fs/promises";
import path from "node:path";
import { probe, validateTranscode } from "./probe.js";
import { ProbeResult } from "./types.js";

const MAX_STAGING_ATTEMPTS = 3;

async function removeIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function createStagedPath(source: string): string {
  return path.join(path.dirname(source), `.${path.basename(source)}.arrse-${randomUUID()}.tmp`);
}

export function isMissingStagedFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function sourceMatches(original: Stats, current: Stats): boolean {
  return original.size === current.size && Math.trunc(original.mtimeMs) === Math.trunc(current.mtimeMs);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function safelyReplace(source: string, cacheOutput: string, inputProbe: ProbeResult): Promise<void> {
  const original = await stat(source);
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_STAGING_ATTEMPTS; attempt += 1) {
    const staged = createStagedPath(source);
    try {
      await copyFile(cacheOutput, staged, constants.COPYFILE_EXCL);
      await chmod(staged, original.mode);
      try {
        await chown(staged, original.uid, original.gid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
      await utimes(staged, original.atime, original.mtime);

      const handle = await open(staged, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }

      const stagedProbe = await probe(staged);
      const errors = validateTranscode(inputProbe, stagedProbe);
      if (errors.length > 0) throw new Error(`staged output validation failed: ${errors.join("; ")}`);

      // Never overwrite a source that changed while the output was copied and
      // validated on its filesystem.
      const current = await stat(source);
      if (!sourceMatches(original, current)) throw new Error("source changed while output was being staged");

      // The staged file is on the source filesystem, so POSIX rename replaces the
      // directory entry atomically without an interval where the source is absent.
      await rename(staged, source);
      return;
    } catch (error) {
      lastError = error;
      await removeIfPresent(staged).catch(() => undefined);
      if (!isMissingStagedFile(error) || attempt === MAX_STAGING_ATTEMPTS) throw error;

      // A media manager or cleanup process can remove hidden temporary files.
      // Retry with a fresh unique name only while the original is still intact.
      const current = await stat(source);
      if (!sourceMatches(original, current)) throw new Error("source changed after staged output disappeared");
      await wait(attempt * 1_000);
    }
  }

  throw lastError ?? new Error("Could not stage replacement output");
}
