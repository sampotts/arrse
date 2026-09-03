export interface Config {
  inputPaths: string[];
  cacheDir: string;
  configDir: string;
  workers: number;
  dryRun: boolean;
  scanIntervalMinutes: number;
  minSavingsPercent: number;
  targetSavingsPercent: number;
  quality: number;
  device: string;
  sonarr?: ApiConfig;
  radarr?: ApiConfig;
}

export type HardwareEncoder = "vaapi-qvbr" | "vaapi-cqp";

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
  bit_rate?: string;
  nb_read_packets?: string;
  color_transfer?: string;
  color_primaries?: string;
  color_space?: string;
  pix_fmt?: string;
  width?: number;
  height?: number;
  coded_width?: number;
  coded_height?: number;
  sample_aspect_ratio?: string;
  display_aspect_ratio?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
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
    bit_rate?: string;
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
  profile?: string;
}

export interface StateFile {
  version: 1;
  files: Record<string, StateEntry>;
}
