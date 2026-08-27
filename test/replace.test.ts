import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createStagedPath, isMissingStagedFile } from "../src/replace.js";

test("creates a unique hidden staging path beside each source", () => {
  const source = "/library/Season 1/Episode.mkv";
  const first = createStagedPath(source);
  const second = createStagedPath(source);

  assert.equal(path.dirname(first), path.dirname(source));
  assert.match(path.basename(first), /^\.Episode\.mkv\.arrse-[a-f0-9-]+\.tmp$/);
  assert.notEqual(first, second);
});

test("only retries a missing staging-file error", () => {
  assert.equal(isMissingStagedFile(Object.assign(new Error("missing"), { code: "ENOENT" })), true);
  assert.equal(isMissingStagedFile(Object.assign(new Error("denied"), { code: "EACCES" })), false);
});
