import { repairAspectRatio } from "./aspect-repair.js";
import { log, quote } from "./logger.js";

async function main(): Promise<void> {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error("usage: node dist/src/repair-aspect.js <file> [file ...]");

  let failed = false;
  for (const file of files) {
    try {
      await repairAspectRatio(file);
    } catch (error) {
      failed = true;
      log("ERROR", `Aspect repair failed; original left in place: ${String(error)} ${quote(file)}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  log("ERROR", `Fatal error: ${String(error)}`);
  process.exitCode = 1;
});
