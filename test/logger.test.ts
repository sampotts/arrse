import assert from "node:assert/strict";
import test from "node:test";
import { log } from "../src/logger.js";

test("prefixes error messages with a cross emoji", () => {
  const original = console.error;
  let output = "";
  console.error = (message?: unknown) => { output = String(message); };
  try {
    log("ERROR", "Job failed");
  } finally {
    console.error = original;
  }
  assert.match(output, /\[ERROR\] ❌ Job failed$/);
});
