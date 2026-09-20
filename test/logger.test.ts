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

test("suppresses skip records", () => {
  const original = console.log;
  const output: string[] = [];
  console.log = (message?: unknown) => { output.push(String(message)); };
  try {
    log("SKIP", "Unchanged file already processed");
    log("INFO", "Scan continues");
  } finally {
    console.log = original;
  }
  assert.equal(output.length, 1);
  assert.match(output[0], /\[INFO\] Scan continues$/);
});
