import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { listStoredImages, newImageId, readImage, saveImage } from "../lib/imageStore";
import { reapOrphans } from "../lib/reaper";
import { createFakeImageIndex, imageRecord } from "./support/fakes";

/** Older than the default 15-minute grace window. */
const LONG_AGO = new Date(Date.now() - 3600_000);

/**
 * Every row-side case needs at least one healthy file in the store, because a
 * scan that finds nothing while rows exist is now refused outright -- see the
 * H9 suite at the bottom of this file.
 */
async function withHealthyFile(): Promise<string> {
  const id = newImageId();
  await saveImage("user_keep", id, Buffer.alloc(3), root);
  return id;
}

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
    assert.equal(report.skippedFilesTooNew, 1);
    assert.notEqual(await readImage("user_a", inflight, root), null);
  });

  it("collects the same file once it is older than the grace window", async () => {
    const inflight = newImageId();
    await saveImage("user_a", inflight, Buffer.alloc(10), root);
    await age("user_a", inflight, 20 * 60_000);

    const report = await reapOrphans({ index: createFakeImageIndex(), root });

    assert.equal(report.orphanFiles.length, 1);
    assert.equal(report.skippedFilesTooNew, 0);
  });
});

describe("reapOrphans: rows with no file", () => {
  it("deletes a row whose file has gone", async () => {
    const healthy = await withHealthyFile();
    const lost = newImageId();
    const index = createFakeImageIndex([
      imageRecord({ id: healthy, userId: "user_keep", createdAt: LONG_AGO }),
      imageRecord({ id: lost, userId: "user_a", createdAt: LONG_AGO }),
    ]);

    const report = await reapOrphans({ index, root });

    assert.deepEqual(report.orphanRows, [{ userId: "user_a", id: lost }]);
    assert.deepEqual(index.rows.map((row) => row.id), [healthy]);
  });

  it("spares a row that is younger than the grace window", async () => {
    // The sweep reads rows and then scans files. A row written after the scan
    // began has a file the scan never saw; deleting it would destroy a fresh
    // upload. This is the row-side twin of the file-side grace window, and it
    // was missing entirely.
    await withHealthyFile();
    const justUploaded = newImageId();
    const index = createFakeImageIndex([
      imageRecord({ id: justUploaded, userId: "user_a", createdAt: new Date() }),
    ]);

    const report = await reapOrphans({ index, root });

    assert.equal(report.orphanRows.length, 0);
    assert.equal(report.skippedRowsTooNew, 1);
    assert.equal(index.rows.length, 1);
  });

  it("keeps a row whose file is present", async () => {
    const id = newImageId();
    await saveImage("user_a", id, Buffer.alloc(10), root);
    const index = createFakeImageIndex([imageRecord({ id, userId: "user_a", createdAt: LONG_AGO })]);

    const report = await reapOrphans({ index, root });

    assert.equal(report.orphanRows.length, 0);
    assert.equal(index.rows.length, 1);
  });

  it("frees the quota those rows were consuming", async () => {
    await withHealthyFile();
    const lost = newImageId();
    const index = createFakeImageIndex([
      imageRecord({ id: lost, userId: "user_a", bytes: 5_000_000, createdAt: LONG_AGO }),
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
      imageRecord({ id: healthy, userId: "user_a", createdAt: LONG_AGO }),
      imageRecord({ id: rowOnly, userId: "user_a", createdAt: LONG_AGO }),
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
    const index = createFakeImageIndex([imageRecord({ id: rowOnly, userId: "user_a", createdAt: LONG_AGO })]);

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

describe("reapOrphans: refuses a scan it cannot trust (regression, H9)", () => {
  it("refuses when the storage root does not exist, instead of deleting every row", async () => {
    // The original bug, exactly. The default root is
    // `process.cwd()/storage/uploads`; an ephemeral filesystem, a fresh
    // deploy, an unset IMAGE_STORAGE_DIR or a process started from the wrong
    // directory all give ENOENT. listStoredImages answers [] because an empty
    // store is not a crash -- and every row in the table then looked like an
    // orphan. Five users, five rows, one missing directory, nothing left.
    const missing = path.join(root, "does", "not", "exist");
    const rows = Array.from({ length: 5 }, (_, i) =>
      imageRecord({ id: newImageId(), userId: `user_${i}`, createdAt: LONG_AGO })
    );
    const index = createFakeImageIndex(rows);

    await assert.rejects(
      () => reapOrphans({ index, root: missing }),
      (error: Error) => {
        assert.equal(error.name, "UntrustworthyScanError");
        assert.match(error.message, /storage root/);
        return true;
      }
    );

    assert.equal(index.rows.length, 5, "not one row may be touched");
  });

  it("refuses when the root exists but is empty and the index is not", async () => {
    // A mount that came back blank looks identical to a table full of orphans.
    // Refusing is recoverable; guessing is a restore from backup.
    const index = createFakeImageIndex([
      imageRecord({ id: newImageId(), userId: "user_a", createdAt: LONG_AGO }),
    ]);

    await assert.rejects(
      () => reapOrphans({ index, root }),
      /holds no images but the index has 1 row/
    );

    assert.equal(index.rows.length, 1);
  });

  it("refuses on a dry run too, rather than reporting a fictional plan", async () => {
    // A dry run that printed "would delete 5 rows" would be read as a finding
    // about the data, when it is a finding about the mount.
    const index = createFakeImageIndex([
      imageRecord({ id: newImageId(), userId: "user_a", createdAt: LONG_AGO }),
    ]);
    await assert.rejects(
      () => reapOrphans({ index, root: path.join(root, "nope"), dryRun: true }),
      /Refusing to reap/
    );
  });

  it("refuses when the root is a file rather than a directory", async () => {
    const notADirectory = path.join(root, "root.txt");
    await writeFile(notADirectory, "not a directory");
    const index = createFakeImageIndex([
      imageRecord({ id: newImageId(), userId: "user_a", createdAt: LONG_AGO }),
    ]);
    await assert.rejects(
      () => reapOrphans({ index, root: notADirectory }),
      /is not a directory/
    );
    assert.equal(index.rows.length, 1);
  });

  it("still runs happily on a genuinely empty deployment", async () => {
    // Empty store AND empty index is not suspicious, it is a new install.
    const report = await reapOrphans({ index: createFakeImageIndex(), root });
    assert.equal(report.scannedFiles, 0);
    assert.equal(report.scannedRows, 0);
  });
});
