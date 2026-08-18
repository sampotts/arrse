import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { cleanupOrphanedCacheFiles, Optimizer, verifyQsv, verifyVaapi } from "./optimizer.js";
import { StateStore } from "./state.js";
import { HardwareEncoder } from "./types.js";

let stopping = false;
const stop = () => { stopping = true; log("INFO", "shutdown requested; waiting for active transcodes"); };
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

async function waitOrStop(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { clearInterval(check); resolve(); }, milliseconds);
    const check = setInterval(() => {
      if (stopping) { clearTimeout(timer); clearInterval(check); resolve(); }
    }, 500);
    timer.unref();
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const state = new StateStore(config.configDir);
  await state.load();
  const orphanedCacheFiles = await cleanupOrphanedCacheFiles(config.cacheDir);
  if (orphanedCacheFiles > 0) log("INFO", "removed orphaned cache outputs", { files: orphanedCacheFiles });
  let encoder: HardwareEncoder = "qsv";
  log("INFO", "Arrse started", {
    inputPaths: config.inputPaths,
    workers: config.workers,
    dryRun: config.dryRun,
    scanIntervalMinutes: config.scanIntervalMinutes
  });
  if (!config.dryRun) {
    while (!stopping) {
      try {
        log("INFO", "checking Intel QSV HEVC encoder", { device: config.qsvDevice });
        try {
          await verifyQsv(config);
          encoder = "qsv";
          log("INFO", "Intel QSV HEVC encoder ready", { device: config.qsvDevice });
        } catch (qsvError) {
          log("INFO", "QSV unavailable; checking Intel VAAPI HEVC fallback", { error: String(qsvError) });
          await verifyVaapi(config);
          encoder = "vaapi";
          log("INFO", "Intel VAAPI HEVC encoder ready", { device: config.qsvDevice });
        }
        break;
      } catch (error) {
        log("ERROR", "Intel hardware encoder self-tests failed; scanning paused and will retry in 60 seconds", { error: String(error) });
        await waitOrStop(60_000);
      }
    }
    if (stopping) return;
  }
  const optimizer = new Optimizer(config, state, encoder);
  do {
    await optimizer.scanOnce();
    if (stopping || config.scanIntervalMinutes === 0) break;
    await waitOrStop(config.scanIntervalMinutes * 60_000);
  } while (!stopping);
}

main().catch((error) => {
  log("ERROR", "fatal error", { error: String(error) });
  process.exitCode = 1;
});
