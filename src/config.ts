import { Config } from "./types.js";
import path from "node:path";

function booleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  if (/^(true|1|yes)$/i.test(value)) return true;
  if (/^(false|0|no)$/i.test(value)) return false;
  throw new Error(`${name} must be true or false`);
}

function integerEnv(name: string, defaultValue: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? defaultValue : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function apiConfig(prefix: "SONARR" | "RADARR") {
  const url = process.env[`${prefix}_URL`]?.replace(/\/$/, "");
  const apiKey = process.env[`${prefix}_API_KEY`];
  if (!url && !apiKey) return undefined;
  if (!url || !apiKey) throw new Error(`${prefix}_URL and ${prefix}_API_KEY must be set together`);
  try {
    new URL(url);
  } catch {
    throw new Error(`${prefix}_URL must be a valid URL`);
  }
  return { url, apiKey };
}

export function loadConfig(): Config {
  let inputPaths: unknown;
  try {
    inputPaths = JSON.parse(process.env.INPUT_PATHS ?? "");
  } catch {
    throw new Error('INPUT_PATHS must be a JSON array such as ["/input"]');
  }
  if (!Array.isArray(inputPaths) || inputPaths.length === 0 || inputPaths.some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new Error("INPUT_PATHS must contain at least one path");
  }
  const normalizedInputPaths = [...new Set(inputPaths.map((value) => value.trim()))];
  if (normalizedInputPaths.some((inputPath) => !path.isAbsolute(inputPath))) {
    throw new Error("INPUT_PATHS entries must be absolute paths");
  }

  return {
    inputPaths: normalizedInputPaths,
    cacheDir: process.env.CACHE_DIR ?? "/cache",
    configDir: process.env.CONFIG_DIR ?? "/config",
    workers: integerEnv("WORKERS", 2, 1, 32),
    dryRun: booleanEnv("DRY_RUN", true),
    scanIntervalMinutes: integerEnv("SCAN_INTERVAL_MINUTES", 60, 0, 10080),
    minSavingsPercent: integerEnv("MIN_SAVINGS_PERCENT", 15, 1, 99),
    qsvQuality: integerEnv("QSV_QUALITY", 23, 1, 51),
    qsvPreset: process.env.QSV_PRESET ?? "medium",
    qsvDevice: process.env.QSV_DEVICE ?? "/dev/dri/renderD128",
    sonarr: apiConfig("SONARR"),
    radarr: apiConfig("RADARR")
  };
}
