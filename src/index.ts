import { loadConfig } from "./config.js";
import { log, quote } from "./logger.js";
import { cleanupOrphanedCacheFiles, Optimizer, verifyQsv, verifyVaapi } from "./optimizer.js";
import { StateStore } from "./state.js";
import { HardwareEncoder } from "./types.js";

let stopping = false;
const shutdown = new AbortController();
const stop = () => {
  if (stopping) return;
  stopping = true;
  log("INFO", "Shutdown requested; cancelling active transcodes.");
  shutdown.abort();
};
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
  if (orphanedCacheFiles > 0) log("INFO", `Removed ${orphanedCacheFiles} orphaned cache output${orphanedCacheFiles === 1 ? "" : "s"}.`);
  let encoder: HardwareEncoder = "qsv";
  log("INFO", `Arrse started. Input paths: ${config.inputPaths.map(quote).join(", ")}. Workers: ${config.workers}. Dry run: ${config.dryRun}. Scan interval: ${config.scanIntervalMinutes} minutes.`);
  if (!config.dryRun) {
    while (!stopping) {
      try {
        log("INFO", `Checking Intel QSV HEVC encoder at ${quote(config.qsvDevice)}.`);
        try {
          await verifyQsv(config, undefined, shutdown.signal);
          encoder = "qsv";
          log("INFO", `Intel QSV HEVC encoder ready at ${quote(config.qsvDevice)}.`);
        } catch (qsvError) {
          log("INFO", `QSV unavailable; checking Intel VAAPI HEVC fallback. Reason: ${String(qsvError)}`);
          await verifyVaapi(config, undefined, shutdown.signal);
          encoder = "vaapi";
          log("INFO", `Intel VAAPI HEVC encoder ready at ${quote(config.qsvDevice)}.`);
        }
        break;
      } catch (error) {
        log("ERROR", `Intel hardware encoder self-tests failed; scanning paused and will retry in 60 seconds. Reason: ${String(error)}`);
        await waitOrStop(60_000);
      }
    }
    if (stopping) return;
  }
  const optimizer = new Optimizer(config, state, encoder, undefined, shutdown.signal);
  do {
    await optimizer.scanOnce();
    if (stopping || config.scanIntervalMinutes === 0) break;
    await waitOrStop(config.scanIntervalMinutes * 60_000);
  } while (!stopping);
}

main().catch((error) => {
  log("ERROR", `Fatal error: ${String(error)}`);
  process.exitCode = 1;
});
