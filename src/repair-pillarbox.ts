import { log, quote } from "./logger.js";
import { PillarboxGeometry, repairPillarbox } from "./pillarbox-repair.js";

function parseArguments(args: string[]): { geometry: PillarboxGeometry; files: string[] } {
  const values = new Map<string, string>();
  const files: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      files.push(arg);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values.set(arg, value);
    index += 1;
  }
  const integer = (name: string): number => {
    const value = Number(values.get(name));
    if (!Number.isInteger(value) || value < 0) throw new Error(`invalid or missing ${name}`);
    return value;
  };
  const sampleAspectRatio = values.get("--sar");
  if (!sampleAspectRatio) throw new Error("missing --sar");
  if (files.length === 0) throw new Error("no files supplied");
  return {
    geometry: {
      expectedWidth: integer("--width"),
      expectedHeight: integer("--height"),
      cropLeft: integer("--left"),
      cropRight: integer("--right"),
      sampleAspectRatio,
      timestamp: values.get("--at")
    },
    files
  };
}

async function main(): Promise<void> {
  const { geometry, files } = parseArguments(process.argv.slice(2));
  let failed = false;
  for (const file of files) {
    try {
      await repairPillarbox(file, geometry);
    } catch (error) {
      failed = true;
      log("ERROR", `Pillarbox repair failed; original left in place: ${String(error)} ${quote(file)}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  log("ERROR", `Fatal error: ${String(error)}. Usage: node dist/src/repair-pillarbox.js --width 1920 --height 1080 --left 284 --right 286 --sar 64:45 [--at 00:10:00] <file ...>`);
  process.exitCode = 1;
});
