import assert from "node:assert/strict";
import test from "node:test";
import { selectMediaFile } from "../src/arr.js";

test("selects the exact media path after a rescan", () => {
  const previous = { id: 10, path: "/library/old-name.mkv" };
  const files = [{ id: 11, path: "/library/current-name.mkv" }];
  assert.equal(selectMediaFile(files, "/library/current-name.mkv", previous)?.id, 11);
});

test("retains the file identity when a rescan changes its path", () => {
  const previous = { id: 10, path: "/library/old-name.mkv" };
  const files = [{ id: 10, path: "/library/renamed-file.mkv" }];
  assert.equal(selectMediaFile(files, "/library/old-name.mkv", previous)?.id, 10);
});

test("falls back to the pre-rescan record when the refreshed list lags", () => {
  const previous = { id: 10, path: "/library/episode.mkv" };
  assert.equal(selectMediaFile([], "/library/episode.mkv", previous)?.id, 10);
});
