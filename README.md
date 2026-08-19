# Arrse

A deliberately small TypeScript service for Sonarr and Radarr. Arrse scans one or more configured media roots, converts eligible H.264 SDR video to HEVC with Intel hardware acceleration, and keeps the original unless the validated result is at least 15% smaller.

All application and test source is TypeScript under `src/` and `test/`. The Docker build runs `tsc` and ships only the compiled JavaScript in `dist/`; there is no hand-written JavaScript application source.

`DRY_RUN=true` is the default. No file is transcoded or replaced until you explicitly set it to `false`.

## Safety and media behavior

- Recursively scans common containers: MKV, MP4, M4V, MOV, TS, and M2TS.
- Only accepts files with exactly one non-artwork H.264 video stream.
- Skips HEVC, AV1, PQ, HLG, Dolby Vision, HDR10+, and streams carrying HDR mastering metadata.
- Maps every input stream. Audio, subtitle, attachment, and data streams are stream-copied; chapters and metadata are mapped from the source.
- Prefers `hevc_qsv` and automatically falls back to `hevc_vaapi` when the Intel QSV/oneVPL path is incompatible. Both use the Intel GPU's hardware HEVC encoder.
- The VAAPI fallback uses zero-copy hardware H.264 decoding and HEVC encoding to keep CPU usage low.
- On startup, removes only abandoned temporary outputs matching Arrse's private cache filename format; unrelated `/cache` files are left alone.
- Uses constant-quantizer encoding at a high-quality default of 20 without scaling. Lower `QSV_QUALITY` values increase quality and file size.
- Runs one-frame hardware encoder self-tests before scanning when `DRY_RUN=false`. If both backends fail, scanning remains paused and the tests retry once per minute without restarting the container.
- Writes the transcode to `/cache`, then validates it with `ffprobe`. Validation checks HEVC video, copied audio/subtitle/attachment codecs and counts, chapter count, and duration.
- Rejects outputs whose resolution, display aspect ratio, frame rate, or SDR color signaling differs from the source.
- Checks the source size and modification time again before replacement, preventing replacement if another program changed it during encoding.
- Copies the validated output to a hidden file beside the source, validates that staged copy again, flushes it, and atomically renames it over the source. The original is never explicitly deleted.
- Requires the configured savings threshold (15% by default) before staging a replacement.
- Keeps `/config/state.json` so unchanged files that failed the savings threshold are not repeatedly encoded.
- Uses an in-memory per-path lock plus a bounded worker pool, so the same source cannot have two concurrent jobs in one service instance. Run only one container against a library.

The service logs status labels including `SCAN`, `SKIP`, `TRANSCODE`, `PROGRESS`, `VALIDATE`, `SAVED`, and `ERROR` as one-line plain-text records. During each transcode, `PROGRESS` is logged at 25%, 50%, 75%, and 100% with FFmpeg's current processing speed and an estimated time remaining.

The ETA is an estimate based on the current encoding speed and becomes more representative as the job progresses. After validation, accepted replacements are marked with `✅` and outputs that miss the savings threshold are marked with `⚠️`.

## Docker setup

1. Confirm the Intel GPU is available on the host as `/dev/dri/renderD128`.
2. Copy `.env.example` to `.env`. Leave `DRY_RUN=true` initially.
3. Set `INPUT_PATH` in `.env`. There is no default input path. The mount must be writable because successful outputs replace their source files in place.
4. Pull and start:

   ```sh
   docker compose pull
   docker compose up -d
   docker compose logs -f arrse
   ```

5. Review dry-run eligibility logs. When satisfied, set `DRY_RUN=false` and recreate the container.

The `/cache` mount should use fast storage with enough free space for every concurrent output. The `/config` mount must use persistent storage.

The Debian FFmpeg package in the image includes QSV support and Intel media drivers. You can verify visibility with:

```sh
docker exec arrse vainfo --display drm --device /dev/dri/renderD128
docker exec arrse ffmpeg -hide_banner -encoders
```

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `ARRSE_IMAGE` | `ghcr.io/sampotts/arrse:latest` | Container image; pin a version for reproducible deployments |
| `DRY_RUN` | `true` | Report eligible files without transcoding |
| `WORKERS` | `2` | Maximum concurrent transcodes (1–32) |
| `SCAN_INTERVAL_MINUTES` | `60` | Delay between scans; `0` runs once and exits |
| `MIN_SAVINGS_PERCENT` | `15` | Minimum reduction required for replacement |
| `QSV_DEVICE` | `/dev/dri/renderD128` | Intel render device |
| `QSV_QUALITY` | `20` | QSV CQP / VAAPI QP quality value (1–51); lower means higher quality and typically larger output |
| `QSV_PRESET` | `medium` | `hevc_qsv` preset; unused by the VAAPI fallback |
| `INPUT_PATHS` | required outside Compose | JSON array of absolute input paths to scan recursively; Compose sets this to `["/input"]` |
| `CACHE_DIR` | `/cache` | Temporary transcode directory |
| `CONFIG_DIR` | `/config` | Persistent state directory |
| `SONARR_URL`, `SONARR_API_KEY` | unset | Optional Sonarr v3 connection |
| `RADARR_URL`, `RADARR_API_KEY` | unset | Optional Radarr v3 connection |

For a Compose installation, the only required path setting is:

```env
INPUT_PATH=/host/path/to/library
```

Compose mounts that directory at `/input`, and Arrse scans it recursively. There is no output-path setting: temporary output uses `/cache`, and a validated, sufficiently smaller result atomically replaces its source. This is equivalent to an output of `.` for every source file.

For advanced deployments with inputs on unrelated host filesystems, add one volume mapping per input and override `INPUT_PATHS` with their in-container paths, for example `INPUT_PATHS=["/input-a","/input-b"]`. Arrse treats every entry identically.

## Sonarr and Radarr

After a successful replacement, the service finds the Sonarr series or Radarr movie whose configured path contains the file. It submits and waits for a rescan, looks up the refreshed media-file record by exact path, then submits `RenameFiles`. This delegates naming to the application's configured rename policy. API failures are logged but never roll back or re-transcode a successfully replaced file.

The URLs must be reachable from this container. With a shared Compose network these are typically `http://sonarr:8989` and `http://radarr:7878`. The paths reported by Sonarr/Radarr must match Arrse's `/data/...` paths; use consistent container volume mappings. Leave both variables for an application unset to disable its integration.

## Development and tests

Requires Node.js 24 LTS or newer.

```sh
npm ci
npm test
```

Tests cover safe configuration defaults, HDR/codec eligibility, output validation, and the FFmpeg stream-mapping/QSV command.

Build and run the local source instead of pulling the published image with the Compose override:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Publishing

GitHub Actions tests every push to `main`, then builds and publishes a Linux AMD64 image to `ghcr.io/sampotts/arrse`. A push to `main` updates `latest` and adds a commit tag such as `sha-a1b2c3d`.

Create a stable release by tagging the tested commit:

```sh
git tag v1.0.0
git push origin v1.0.0
```

That publishes `1.0.0`, `1.0`, `latest`, and a commit-specific tag. The workflow also supports a manual run from GitHub's Actions page. Container provenance is attached to each published image.

The published Arrse image is public, so Compose can pull it without a registry login. If a private fork publishes under a private package, authenticate first with `docker login ghcr.io` using a token that has `read:packages` permission.

## Recovery notes

An interrupted encode only leaves a uniquely named file in `/cache`, which the next job does not reuse. An interruption during same-filesystem staging may leave a hidden `.arrse-*.tmp` file beside the source; the original path remains intact unless the final atomic rename completed. Such stale hidden files can be inspected and removed manually.
