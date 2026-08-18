import { opendir } from "node:fs/promises";
import path from "node:path";

const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".m4v", ".mov", ".ts", ".m2ts"]);

export async function* scan(root: string): AsyncGenerator<string> {
  let directory;
  try {
    directory = await opendir(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES") throw new Error(`cannot scan ${root}: ${code}`);
    throw error;
  }
  for await (const entry of directory) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) yield* scan(fullPath);
    else if (entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) yield fullPath;
  }
}
