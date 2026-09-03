# Arrse

A deliberately small TypeScript service for Sonarr and Radarr. Arrse scans one or more configured media roots, converts eligible H.264 SDR video to HEVC with Intel hardware acceleration, and keeps the original unless the validated result is at least 15% smaller.

All application and test source is TypeScript under `src/` and `test/`. The Docker build runs `tsc` and ships only the compiled JavaScript in `dist/`; there is no hand-written JavaScript application source.

`DRY_RUN=true` is the default. No file is transcoded or replaced until you explicitly set it to `false`.

## Safety and media behavior

- Recursively scans common containers: MKV, MP4, M4V, MOV, TS, and M2TS.
- Only accepts files with exactly one non-artwork H.264 video stream.
- Skips HEVC, AV1, PQ, HLG, Dolby Vision, HDR10+, and streams carrying HDR mastering metadata.
- Skips remux sources by default using common filename and embedded-title markers; set `PROCESS_REMUX=true` to opt in.
- Maps every input stream. Audio, subtitle, attachment, and data streams are stream-copied; chapters and metadata are mapped from the source.
- Uses zero-copy VAAPI hardware H.264 decoding and `hevc_vaapi` HEVC encoding on the Intel GPU.
- Prefers QVBR rate control, targeting a useful whole-file reduction while using the quality setting as a quality bound. If the driver does not expose QVBR, Arrse automatically falls back to CQP.
- Calculates each QVBR video bitrate from the source size, duration, and estimated bitrate of copied audio, subtitle, attachment, and data streams.
- On startup, removes only abandoned temporary outputs matching Arrse's private cache filename format; unrelated `/cache` files are left alone.
- Uses a high-quality default of 20 without scaling. Lower `QUALITY` values increase quality and usually increase file size.
- Ships checksum-pinned FFmpeg 9.0.1 built with Intel oneVPL and VAAPI support.
- Runs hardware QVBR and CQP self-tests before scanning when `DRY_RUN=false`. If both modes fail, scanning remains paused and the tests retry once per minute without restarting the container.
- Writes the transcode to `/cache`, then validates it with `ffprobe`. Validation checks HEVC video, copied audio/subtitle/attachment codecs and counts, chapter count, and duration.
- Skips standard-resolution H.264 sources whose explicit aspect metadata conflicts with their natural display ratio instead of guessing or modifying their intent.
- Normalizes standard HD/UHD frame sizes to square pixels and their natural display ratio. Nonstandard and anamorphic frame sizes retain their declared aspect ratio.
- Rejects outputs whose resolution, sample/display aspect ratio, frame rate, or SDR color signaling is incorrect.
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

On Intel platforms whose QVBR support depends on authenticated HuC firmware, enable HuC in the host's i915 module configuration and reboot:

```text
options i915 enable_guc=2
```

Verify it with `cat /sys/module/i915/parameters/enable_guc` and `dmesg | grep -i huc`. The latter should report that HuC is authenticated. Arrse remains usable in CQP mode if QVBR is unavailable.

The image includes its own FFmpeg build and Intel media drivers. You can verify visibility with:

```sh
docker exec arrse vainfo --display drm --device /dev/dri/renderD128
docker exec arrse ffmpeg -hide_banner -encoders
```

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `ARRSE_IMAGE` | `ghcr.io/sampotts/arrse:latest` | Container image; pin a version for reproducible deployments |
| `DRY_RUN` | `true` | Report eligible files without transcoding |
| `PROCESS_REMUX` | `false` | Process remux sources; disabled by default to preserve original disc quality |
| `WORKERS` | `2` | Maximum concurrent transcodes (1–32) |
| `SCAN_INTERVAL_MINUTES` | `60` | Delay between scans; `0` runs once and exits |
| `MIN_SAVINGS_PERCENT` | `15` | Minimum reduction required for replacement |
| `TARGET_SAVINGS_PERCENT` | `20` | Whole-file reduction QVBR targets when choosing its video bitrate; must be at least `MIN_SAVINGS_PERCENT` |
| `QUALITY` | `20` | QVBR quality bound or CQP quantizer (1–51); lower means higher quality and typically larger output |
| `INTEL_DEVICE` | `/dev/dri/renderD128` | Intel render device |
| `QSV_QUALITY`, `QSV_DEVICE` | unset | Deprecated aliases for `QUALITY` and `INTEL_DEVICE` |
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

The QVBR target defaults to 20%, giving the final 15% replacement threshold some headroom. Changing `QUALITY` changes the quality constraint, while `TARGET_SAVINGS_PERCENT` controls the intended size reduction. Existing state entries from an older encoding profile are automatically reconsidered once; files already converted to HEVC remain ineligible.

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

Tests cover safe configuration defaults, HDR/codec eligibility, output validation, state migration, and the FFmpeg VAAPI QVBR/CQP commands.

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

Audit a file or directory recursively for malformed aspect metadata without changing anything:

```sh
docker exec arrse node dist/src/audit-aspect.js \
  "/data/path/to/library"
```

The old metadata-only repair command is disabled because hardware decoders may ignore its left crop. Measured HEVC pillarboxes can instead be removed physically with a high-quality Intel hardware repair:

```sh
docker exec arrse node dist/src/repair-pillarbox.js \
  --width 1920 --height 1080 \
  --left 284 --right 286 --sar 64:45 \
  "/data/path/to/affected-file.mp4"
```

Multiple files may be supplied. Before writing anything, Arrse decodes a sample frame and confirms that its black boundaries match the requested crop. It re-encodes only the video at high-quality CQP 16 by default, copies all other streams to `/cache`, validates streams, visible dimensions, aspect ratio, chapters, and duration, stages beside the source, and atomically replaces it. Use `--quality` to override the repair quality. A mismatch or error leaves the original untouched.
