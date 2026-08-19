import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { scan } from "../src/scan.js";
import { StateStore } from "../src/state.js";

test("scanner recurses and returns only supported media containers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "optimizer-scan-"));
  try {
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "episode.mkv"), "media");
    await writeFile(path.join(root, "notes.txt"), "ignore");
    await writeFile(path.join(root, "nested", "movie.MP4"), "media");
    const files: string[] = [];
    for await (const file of scan(root)) files.push(path.relative(root, file));
    assert.deepEqual(files.sort(), ["episode.mkv", path.join("nested", "movie.MP4")].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("state suppresses only unchanged completed decisions", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "optimizer-state-"));
  try {
    const media = path.join(root, "video.mkv");
    await writeFile(media, "original bytes");
    const initial = await import("node:fs/promises").then(({ stat }) => stat(media));
    const state = new StateStore(path.join(root, "config"));
    await state.load();
    await state.record(media, "not-smaller", "10% savings");
    assert.equal(state.isCurrent(media, initial.size, initial.mtimeMs), true);
    assert.equal(state.isCurrent(media, initial.size, initial.mtimeMs, "v2:vaapi-qvbr"), false);

    await state.record(media, "not-smaller", "10% savings", "v2:vaapi-qvbr");
    assert.equal(state.isCurrent(media, initial.size, initial.mtimeMs, "v2:vaapi-qvbr"), true);
    assert.equal(state.isCurrent(media, initial.size, initial.mtimeMs, "v2:vaapi-cqp"), false);

    await utimes(media, new Date(), new Date(initial.mtimeMs + 2_000));
    const changed = await import("node:fs/promises").then(({ stat }) => stat(media));
    assert.equal(state.isCurrent(media, changed.size, changed.mtimeMs), false);

    await state.record(media, "error", "temporary failure");
    assert.equal(state.isCurrent(media, changed.size, changed.mtimeMs), false);

    const reloaded = new StateStore(path.join(root, "config"));
    await reloaded.load();
    assert.equal(reloaded.isCurrent(media, changed.size, changed.mtimeMs), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
