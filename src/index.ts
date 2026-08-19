import { loadConfig } from "./config.js";
import { log, quote } from "./logger.js";
import { cleanupOrphanedCacheFiles, Optimizer, verifyVaapiCqp, verifyVaapiQvbr } from "./optimizer.js";
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
  let encoder: HardwareEncoder = "vaapi-qvbr";
  log("INFO", `Arrse started. Input paths: ${config.inputPaths.map(quote).join(", ")}. Workers: ${config.workers}. Dry run: ${config.dryRun}. Scan interval: ${config.scanIntervalMinutes} minutes.`);
  if (!config.dryRun) {
    while (!stopping) {
      try {
        log("INFO", `Checking Intel VAAPI QVBR HEVC encoder at ${quote(config.device)}.`);
        try {
          await verifyVaapiQvbr(config, undefined, shutdown.signal);
          encoder = "vaapi-qvbr";
          log("INFO", `Intel VAAPI QVBR HEVC encoder ready at ${quote(config.device)}.`);
        } catch (qvbrError) {
          log("INFO", `VAAPI QVBR unavailable; checking CQP fallback. Reason: ${String(qvbrError)}`);
          await verifyVaapiCqp(config, undefined, shutdown.signal);
          encoder = "vaapi-cqp";
          log("INFO", `Intel VAAPI CQP HEVC encoder ready at ${quote(config.device)}.`);
        }
        break;
      } catch (error) {
        log("ERROR", `Intel VAAPI encoder self-tests failed; scanning paused and will retry in 60 seconds. Reason: ${String(error)}`);
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
