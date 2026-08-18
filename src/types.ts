export interface Config {
  inputPaths: string[];
  cacheDir: string;
  configDir: string;
  workers: number;
  dryRun: boolean;
  scanIntervalMinutes: number;
  minSavingsPercent: number;
  qsvQuality: number;
  qsvPreset: string;
  qsvDevice: string;
  sonarr?: ApiConfig;
  radarr?: ApiConfig;
}

export interface ApiConfig {
  url: string;
  apiKey: string;
}

export interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  profile?: string;
  duration?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_space?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  display_aspect_ratio?: string;
  avg_frame_rate?: string;
  disposition?: Record<string, number>;
  tags?: Record<string, string>;
  side_data_list?: Array<Record<string, unknown>>;
}

export interface ProbeResult {
  streams: ProbeStream[];
  chapters?: unknown[];
  format?: {
    duration?: string;
    size?: string;
    format_name?: string;
    tags?: Record<string, string>;
  };
}

export type StateOutcome = "saved" | "not-smaller" | "dry-run" | "error";

export interface StateEntry {
  size: number;
  mtimeMs: number;
  outcome: StateOutcome;
  updatedAt: string;
  detail?: string;
}

export interface StateFile {
  version: 1;
  files: Record<string, StateEntry>;
}
