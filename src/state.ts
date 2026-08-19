import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { StateEntry, StateFile, StateOutcome } from "./types.js";

export class StateStore {
  private data: StateFile = { version: 1, files: {} };
  private readonly file: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(configDir: string) {
    this.file = path.join(configDir, "state.json");
  }

  async load(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as StateFile;
      if (parsed.version !== 1 || typeof parsed.files !== "object") throw new Error("unsupported state format");
      this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        await rename(this.file, backup);
        console.error(`State file was invalid and moved to ${backup}`);
      }
    }
  }

  isCurrent(file: string, size: number, mtimeMs: number, profile?: string): boolean {
    const entry = this.data.files[file];
    return Boolean(entry && entry.size === size && Math.trunc(entry.mtimeMs) === Math.trunc(mtimeMs) && entry.outcome !== "error" && entry.outcome !== "dry-run" && (profile === undefined || entry.profile === profile));
  }

  async record(file: string, outcome: StateOutcome, detail?: string, profile?: string): Promise<void> {
    const info = await stat(file);
    const entry: StateEntry = { size: info.size, mtimeMs: info.mtimeMs, outcome, updatedAt: new Date().toISOString(), detail, profile };
    this.data.files[file] = entry;
    this.writeChain = this.writeChain.then(async () => {
      const temp = `${this.file}.tmp`;
      await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, this.file);
    });
    await this.writeChain;
  }
}
