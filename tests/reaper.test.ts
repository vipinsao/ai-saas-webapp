import assert from "node:assert/strict";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { listStoredImages, newImageId, readImage, saveImage } from "../lib/imageStore";
import { reapOrphans } from "../lib/reaper";
import { createFakeImageIndex, imageRecord } from "./support/fakes";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "reaper-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Backdates a file so it falls outside the reaper's grace window. */
async function age(ownerId: string, imageId: string, ms: number) {
  const when = new Date(Date.now() - ms);
  await utimes(path.join(root, ownerId, `${imageId}.webp`), when, when);
}

describe("reapOrphans: files with no row", () => {
  it("deletes an orphan file and counts the bytes it reclaimed", async () => {
    const orphan = newImageId();
    await saveImage("user_a", orphan, Buffer.alloc(1234), root);
    await age("user_a", orphan, 3600_000);

    const report = await reapOrphans({ index: createFakeImageIndex(), root });

    assert.equal(report.orphanFiles.length, 1);
    assert.equal(report.orphanFiles[0].imageId, orphan);
    assert.equal(report.bytesReclaimed, 1234);
    assert.equal(await readImage("user_a", orphan, root), null);
  });

  it("leaves files that still have a row", async () => {
    const kept = newImageId();
    await saveImage("user_a", kept, Buffer.alloc(10), root);
    await age("user_a", kept, 3600_000);
    const index = createFakeImageIndex([imageRecord({ id: kept, userId: "user_a" })]);

    const report = await reapOrphans({ index, root });

    assert.equal(report.orphanFiles.length, 0);
    assert.notEqual(await readImage("user_a", kept, root), null);
  });

  it("does not treat one user's row as cover for another user's file", async () => {
    // Same image id, different owner: the row belongs to user_a, the file on
    // disk belongs to user_b. Matching on the id alone would spare it.
    const id = newImageId();
    await saveImage("user_b", id, Buffer.alloc(7), root);
    await age("user_b", id, 3600_000);
    const index = createFakeImageIndex([imageRecord({ id, userId: "user_a" })]);

    const report = await reapOrphans({ index, root });

    assert.equal(report.orphanFiles.length, 1);
    assert.equal(report.orphanFiles[0].ownerId, "user_b");
  });

  it("spares a file that is younger than the grace window", async () => {
    // An upload writes the file before the row. Without the grace window the
    // reaper would race a live upload and delete the bytes out from under it.
    const inflight = newImageId();
    await saveImage("user_a", inflight, Buffer.alloc(10), root);

    const report = await reapOrphans({ index: createFakeImageIndex(), root });

    assert.equal(report.orphanFiles.length, 0);
    assert.equal(report.skippedTooNew, 1);
    assert.notEqual(await readImage("user_a", inflight, root), null);
  });

  it("collects the same file once it is older than the grace window", async () => {
    const inflight = newImageId();
    await saveImage("user_a", inflight, Buffer.alloc(10), root);
    await age("user_a", inflight, 20 * 60_000);

    const report = await reapOrphans({ index: createFakeImageIndex(), root });

    assert.equal(report.orphanFiles.length, 1);
    assert.equal(report.skippedTooNew, 0);
  });
});

describe("reapOrphans: rows with no file", () => {
  it("deletes a row whose file has gone", async () => {
    const lost = newImageId();
    const index = createFakeImageIndex([imageRecord({ id: lost, userId: "user_a" })]);

    const report = await reapOrphans({ index, root });

    assert.deepEqual(report.orphanRows, [{ userId: "user_a", id: lost }]);
    assert.equal(index.rows.length, 0);
  });

  it("keeps a row whose file is present", async () => {
    const id = newImageId();
    await saveImage("user_a", id, Buffer.alloc(10), root);
    const index = createFakeImageIndex([imageRecord({ id, userId: "user_a" })]);

    const report = await reapOrphans({ index, root });

    assert.equal(report.orphanRows.length, 0);
    assert.equal(index.rows.length, 1);
  });

  it("frees the quota those rows were consuming", async () => {
    const lost = newImageId();
    const index = createFakeImageIndex([
      imageRecord({ id: lost, userId: "user_a", bytes: 5_000_000 }),
    ]);
    assert.equal(await index.usedBytes("user_a"), 5_000_000);

    await reapOrphans({ index, root });

    assert.equal(await index.usedBytes("user_a"), 0);
  });
});

describe("reapOrphans: both directions at once", () => {
  it("handles a store that is broken in both ways in a single pass", async () => {
    const healthy = newImageId();
    const fileOnly = newImageId();
    const rowOnly = newImageId();

    await saveImage("user_a", healthy, Buffer.alloc(11), root);
    await saveImage("user_a", fileOnly, Buffer.alloc(22), root);
    await age("user_a", fileOnly, 3600_000);

    const index = createFakeImageIndex([
      imageRecord({ id: healthy, userId: "user_a" }),
      imageRecord({ id: rowOnly, userId: "user_a" }),
    ]);

    const report = await reapOrphans({ index, root });

    assert.equal(report.scannedFiles, 2);
    assert.equal(report.scannedRows, 2);
    assert.deepEqual(report.orphanFiles.map((file) => file.imageId), [fileOnly]);
    assert.deepEqual(report.orphanRows.map((row) => row.id), [rowOnly]);

    // What is left is exactly the consistent pair.
    assert.deepEqual(index.rows.map((row) => row.id), [healthy]);
    assert.deepEqual((await listStoredImages(root)).map((file) => file.imageId), [healthy]);
  });
});

describe("reapOrphans: dry run", () => {
  it("reports without deleting anything", async () => {
    const fileOnly = newImageId();
    const rowOnly = newImageId();
    await saveImage("user_a", fileOnly, Buffer.alloc(9), root);
    await age("user_a", fileOnly, 3600_000);
    const index = createFakeImageIndex([imageRecord({ id: rowOnly, userId: "user_a" })]);

    const report = await reapOrphans({ index, root, dryRun: true });

    assert.equal(report.dryRun, true);
    assert.equal(report.orphanFiles.length, 1);
    assert.equal(report.orphanRows.length, 1);
    assert.equal(report.bytesReclaimed, 0);
    assert.notEqual(await readImage("user_a", fileOnly, root), null);
    assert.equal(index.rows.length, 1);
  });
});

describe("reapOrphans: nothing to do", () => {
  it("is a no-op on an empty store with an empty index", async () => {
    const report = await reapOrphans({ index: createFakeImageIndex(), root });
    assert.deepEqual(
      { files: report.orphanFiles.length, rows: report.orphanRows.length },
      { files: 0, rows: 0 }
    );
  });
});
