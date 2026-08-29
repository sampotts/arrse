export type LogStatus = "SCAN" | "AUDIT" | "SKIP" | "TRANSCODE" | "PROGRESS" | "VALIDATE" | "SAVED" | "ERROR" | "INFO";

export function quote(value: string): string {
  return JSON.stringify(value);
}

export function log(status: LogStatus, message: string): void {
  const singleLineMessage = message.replace(/[\r\n]+/g, " ").trim();
  const line = `${new Date().toISOString()} [${status}] ${singleLineMessage}`;
  if (status === "ERROR") console.error(line);
  else console.log(line);
}
