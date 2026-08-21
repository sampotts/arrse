import path from "node:path";
import { log, quote } from "./logger.js";
import { ApiConfig } from "./types.js";

interface ArrItem { id: number; path: string }
interface ArrFile { id: number; path: string }
interface ArrCommand { id: number; status?: string; message?: string }

async function request<T>(config: ApiConfig, route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${config.url}/api/v3${route}`, {
    ...init,
    headers: {
      "X-Api-Key": config.apiKey,
      "Content-Type": "application/json",
      ...init?.headers
    },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} from ${route}`);
  return await response.json() as T;
}

async function command(config: ApiConfig, body: Record<string, unknown>): Promise<ArrCommand> {
  return await request<ArrCommand>(config, "/command", { method: "POST", body: JSON.stringify(body) });
}

async function waitForCommand(config: ApiConfig, id: number): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const result = await request<ArrCommand>(config, `/command/${id}`);
    const status = result.status?.toLowerCase();
    if (status === "completed") return;
    if (status === "failed" || status === "aborted") throw new Error(result.message ?? `command ${id} ${status}`);
  }
  throw new Error(`command ${id} did not complete within 120 seconds`);
}

function samePath(left: string, right: string): boolean {
  return path.normalize(left) === path.normalize(right);
}

function containingItem(items: ArrItem[], file: string): ArrItem | undefined {
  return items
    .filter((item) => samePath(file, item.path) || path.normalize(file).startsWith(`${path.normalize(item.path)}${path.sep}`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

export function selectMediaFile(files: ArrFile[], file: string, previous?: ArrFile): ArrFile | undefined {
  return files.find((candidate) => samePath(candidate.path, file))
    ?? (previous ? files.find((candidate) => candidate.id === previous.id) : undefined)
    ?? previous;
}

async function notifyOne(kind: "Sonarr" | "Radarr", config: ApiConfig, file: string): Promise<boolean> {
  const isSonarr = kind === "Sonarr";
  const itemRoute = isSonarr ? "/series" : "/movie";
  const idName = isSonarr ? "seriesId" : "movieId";
  const items = await request<ArrItem[]>(config, itemRoute);
  const item = containingItem(items, file);
  if (!item) return false;

  const fileRoute = `/${isSonarr ? "episodefile" : "moviefile"}?${idName}=${item.id}`;
  const filesBeforeRescan = await request<ArrFile[]>(config, fileRoute);
  const previousMediaFile = filesBeforeRescan.find((candidate) => samePath(candidate.path, file));
  const rescan = await command(config, { name: isSonarr ? "RescanSeries" : "RescanMovie", [idName]: item.id });
  await waitForCommand(config, rescan.id);

  const filesAfterRescan = await request<ArrFile[]>(config, fileRoute);
  const mediaFile = selectMediaFile(filesAfterRescan, file, previousMediaFile);
  if (!mediaFile) {
    log("INFO", `${kind} rescan completed, but the file is not indexed; rename skipped ${quote(file)}`);
    return true;
  }

  const rename = await command(config, { name: "RenameFiles", [idName]: item.id, files: [mediaFile.id] });
  await waitForCommand(config, rename.id);
  log("INFO", `${kind} rescan and rename completed ${quote(file)}`);
  return true;
}

export async function notifyArr(file: string, sonarr?: ApiConfig, radarr?: ApiConfig): Promise<void> {
  const attempts: Array<Promise<boolean>> = [];
  if (sonarr) attempts.push(notifyOne("Sonarr", sonarr, file));
  if (radarr) attempts.push(notifyOne("Radarr", radarr, file));
  if (attempts.length === 0) return;
  const results = await Promise.allSettled(attempts);
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  const matched = results.some((result) => result.status === "fulfilled" && result.value);
  for (const error of errors) log("ERROR", `Arr integration failed: ${String(error.reason)} ${quote(file)}`);
  if (!matched && errors.length === 0) log("INFO", `No Sonarr or Radarr library root matched file ${quote(file)}`);
}
