import { log } from "./logger.js";

async function main(): Promise<void> {
  throw new Error("square-pixel aspect repair is disabled because it can squash anamorphic sources; use the measured pillarbox repair command instead");
}

main().catch((error) => {
  log("ERROR", `Fatal error: ${String(error)}`);
  process.exitCode = 1;
});
