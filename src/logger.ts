export type LogStatus = "SCAN" | "SKIP" | "TRANSCODE" | "PROGRESS" | "VALIDATE" | "SAVED" | "ERROR" | "INFO";

export function log(status: LogStatus, message: string, details?: Record<string, unknown>): void {
  const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
  const line = `${new Date().toISOString()} [${status}] ${message}${suffix}`;
  if (status === "ERROR") console.error(line);
  else console.log(line);
}
