import { auditAspectRatios } from "./aspect-audit.js";

async function main(): Promise<void> {
  const roots = process.argv.slice(2);
  if (roots.length === 0) throw new Error("usage: node dist/src/audit-aspect.js <file-or-directory> [file-or-directory ...]");
  const result = await auditAspectRatios(roots);
  if (result.errors > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Aspect audit failed: ${String(error)}`);
  process.exitCode = 1;
});
