import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const managed = ["MEDIA_PATHS", "CACHE_DIR", "CONFIG_DIR", "WORKERS", "DRY_RUN", "SCAN_INTERVAL_MINUTES", "MIN_SAVINGS_PERCENT", "QSV_QUALITY", "QSV_PRESET", "QSV_DEVICE", "SONARR_URL", "SONARR_API_KEY", "RADARR_URL", "RADARR_API_KEY"];

test("safe defaults include dry-run and two workers", () => {
  const saved = Object.fromEntries(managed.map((key) => [key, process.env[key]]));
  try {
    for (const key of managed) delete process.env[key];
    process.env.MEDIA_PATHS = '["/media"]';
    const config = loadConfig();
    assert.equal(config.dryRun, true);
    assert.equal(config.workers, 2);
    assert.deepEqual(config.mediaPaths, ["/media"]);
    assert.equal(config.minSavingsPercent, 15);
  } finally {
    for (const key of managed) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("requires Arr URL and API key together", () => {
  const oldUrl = process.env.SONARR_URL;
  const oldKey = process.env.SONARR_API_KEY;
  const oldPaths = process.env.MEDIA_PATHS;
  try {
    process.env.MEDIA_PATHS = '["/media"]';
    process.env.SONARR_URL = "http://sonarr:8989";
    delete process.env.SONARR_API_KEY;
    assert.throws(loadConfig, /must be set together/);
  } finally {
    if (oldUrl === undefined) delete process.env.SONARR_URL; else process.env.SONARR_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SONARR_API_KEY; else process.env.SONARR_API_KEY = oldKey;
    if (oldPaths === undefined) delete process.env.MEDIA_PATHS; else process.env.MEDIA_PATHS = oldPaths;
  }
});

test("accepts configurable media paths and rejects invalid arrays", () => {
  const oldPaths = process.env.MEDIA_PATHS;
  try {
    process.env.MEDIA_PATHS = '["/library/tv", "/archive/movies"]';
    assert.deepEqual(loadConfig().mediaPaths, ["/library/tv", "/archive/movies"]);
    process.env.MEDIA_PATHS = "[]";
    assert.throws(loadConfig, /at least one path/);
    process.env.MEDIA_PATHS = '["relative/path"]';
    assert.throws(loadConfig, /must be absolute paths/);
    process.env.MEDIA_PATHS = "not-json";
    assert.throws(loadConfig, /must be a JSON array/);
  } finally {
    if (oldPaths === undefined) delete process.env.MEDIA_PATHS;
    else process.env.MEDIA_PATHS = oldPaths;
  }
});
