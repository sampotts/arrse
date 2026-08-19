import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const managed = ["INPUT_PATHS", "CACHE_DIR", "CONFIG_DIR", "WORKERS", "DRY_RUN", "SCAN_INTERVAL_MINUTES", "MIN_SAVINGS_PERCENT", "TARGET_SAVINGS_PERCENT", "QUALITY", "INTEL_DEVICE", "QSV_QUALITY", "QSV_DEVICE", "SONARR_URL", "SONARR_API_KEY", "RADARR_URL", "RADARR_API_KEY"];

test("safe defaults include dry-run and two workers", () => {
  const saved = Object.fromEntries(managed.map((key) => [key, process.env[key]]));
  try {
    for (const key of managed) delete process.env[key];
    process.env.INPUT_PATHS = '["/input"]';
    const config = loadConfig();
    assert.equal(config.dryRun, true);
    assert.equal(config.workers, 2);
    assert.deepEqual(config.inputPaths, ["/input"]);
    assert.equal(config.minSavingsPercent, 15);
    assert.equal(config.quality, 20);
    assert.equal(config.targetSavingsPercent, 20);
    assert.equal(config.device, "/dev/dri/renderD128");
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
  const oldPaths = process.env.INPUT_PATHS;
  try {
    process.env.INPUT_PATHS = '["/input"]';
    process.env.SONARR_URL = "http://sonarr:8989";
    delete process.env.SONARR_API_KEY;
    assert.throws(loadConfig, /must be set together/);
  } finally {
    if (oldUrl === undefined) delete process.env.SONARR_URL; else process.env.SONARR_URL = oldUrl;
    if (oldKey === undefined) delete process.env.SONARR_API_KEY; else process.env.SONARR_API_KEY = oldKey;
    if (oldPaths === undefined) delete process.env.INPUT_PATHS; else process.env.INPUT_PATHS = oldPaths;
  }
});

test("accepts configurable input paths and rejects invalid arrays", () => {
  const oldPaths = process.env.INPUT_PATHS;
  try {
    process.env.INPUT_PATHS = '["/library/tv", "/archive/movies"]';
    assert.deepEqual(loadConfig().inputPaths, ["/library/tv", "/archive/movies"]);
    process.env.INPUT_PATHS = "[]";
    assert.throws(loadConfig, /at least one path/);
    process.env.INPUT_PATHS = '["relative/path"]';
    assert.throws(loadConfig, /must be absolute paths/);
    process.env.INPUT_PATHS = "not-json";
    assert.throws(loadConfig, /must be a JSON array/);
  } finally {
    if (oldPaths === undefined) delete process.env.INPUT_PATHS;
    else process.env.INPUT_PATHS = oldPaths;
  }
});

test("requires the QVBR target to meet the replacement threshold", () => {
  const saved = Object.fromEntries(managed.map((key) => [key, process.env[key]]));
  try {
    for (const key of managed) delete process.env[key];
    process.env.INPUT_PATHS = '["/input"]';
    process.env.MIN_SAVINGS_PERCENT = "25";
    assert.equal(loadConfig().targetSavingsPercent, 30);
    process.env.TARGET_SAVINGS_PERCENT = "20";
    assert.throws(loadConfig, /TARGET_SAVINGS_PERCENT must be an integer from 25 to 99/);
  } finally {
    for (const key of managed) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key]!;
  }
});

test("accepts legacy QSV quality and device aliases", () => {
  const saved = Object.fromEntries(managed.map((key) => [key, process.env[key]]));
  try {
    for (const key of managed) delete process.env[key];
    process.env.INPUT_PATHS = '["/input"]';
    process.env.QSV_QUALITY = "21";
    process.env.QSV_DEVICE = "/dev/dri/renderD129";
    assert.equal(loadConfig().quality, 21);
    assert.equal(loadConfig().device, "/dev/dri/renderD129");
  } finally {
    for (const key of managed) saved[key] === undefined ? delete process.env[key] : process.env[key] = saved[key]!;
  }
});
