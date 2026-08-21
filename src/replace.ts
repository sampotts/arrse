import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, copyFile, open, rename, stat, unlink, utimes } from "node:fs/promises";
import path from "node:path";
import { probe, validateTranscode } from "./probe.js";
import { ProbeResult } from "./types.js";

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

export async function safelyReplace(source: string, cacheOutput: string, inputProbe: ProbeResult): Promise<void> {
  const original = await stat(source);
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

    // The staged file is on the source filesystem, so POSIX rename replaces the
    // directory entry atomically without an interval where the source is absent.
    await rename(staged, source);
  } catch (error) {
    await removeIfPresent(staged).catch(() => undefined);
    throw error;
  }
}
