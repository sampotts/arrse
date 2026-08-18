import { spawn } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
}

export async function run(
  command: string, args: string[], signal?: AbortSignal, onStdout?: (chunk: string) => void
): Promise<RunResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      onStdout?.(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, childSignal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code ?? childSignal}: ${stderr.trim().slice(-2000)}`));
    });
  });
}
