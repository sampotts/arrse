import { loadConfig } from "./config.js";
import { log } from "./logger.js";
import { Optimizer, verifyQsv } from "./optimizer.js";
import { StateStore } from "./state.js";

let stopping = false;
const stop = () => { stopping = true; log("INFO", "shutdown requested; waiting for active transcodes"); };
process.once("SIGTERM", stop);
process.once("SIGINT", stop);

async function main(): Promise<void> {
  const config = loadConfig();
  const state = new StateStore(config.configDir);
  await state.load();
  const optimizer = new Optimizer(config, state);
  log("INFO", "Arrse started", {
    inputPaths: config.inputPaths,
    workers: config.workers,
    dryRun: config.dryRun,
    scanIntervalMinutes: config.scanIntervalMinutes
  });
  if (!config.dryRun) {
    log("INFO", "checking Intel QSV HEVC encoder", { device: config.qsvDevice });
    await verifyQsv(config);
    log("INFO", "Intel QSV HEVC encoder ready", { device: config.qsvDevice });
  }
  do {
    await optimizer.scanOnce();
    if (stopping || config.scanIntervalMinutes === 0) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { clearInterval(check); resolve(); }, config.scanIntervalMinutes * 60_000);
      const check = setInterval(() => {
        if (stopping) { clearTimeout(timer); clearInterval(check); resolve(); }
      }, 500);
      timer.unref();
    });
  } while (!stopping);
}

main().catch((error) => {
  log("ERROR", "fatal error", { error: String(error) });
  process.exitCode = 1;
});
