/**
 * The owner action DECISIONS.md named and did not have.
 *
 * The delete route keeps the Video row when Cloudinary answers "not found",
 * because that string is not proof of absence. Both the handler comment and
 * DECISIONS.md then said clearing such a row is "an owner action" — and no
 * endpoint, script or npm task could do it, and VideoIndex had no un-scoped
 * delete on it at all. These cover the mechanism that now exists.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forgetVideo } from "../lib/forgetVideo";
import { createFakeVideoIndex, videoRecord } from "./support/fakes";

const STRANDED = videoRecord({
  id: "vid_1",
  userId: "user_a",
  publicId: "cloudinary/folder/abc123",
});

describe("forgetVideo", () => {
  it("removes the row when the publicId is confirmed", async () => {
    const index = createFakeVideoIndex([STRANDED]);

    const result = await forgetVideo({
      index,
      id: "vid_1",
      confirmPublicId: "cloudinary/folder/abc123",
      dryRun: false,
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.rowsRemoved, 1);
    assert.deepEqual(index.rows, []);
  });

  it("reports without deleting by default", async () => {
    // The default has to be the safe one: this is the only operation in the app
    // that throws away the last handle on a remote asset. Getting it wrong means
    // an asset that is invisible and still billed.
    const index = createFakeVideoIndex([STRANDED]);

    const result = await forgetVideo({
      index,
      id: "vid_1",
      confirmPublicId: "cloudinary/folder/abc123",
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.dryRun, true);
    assert.equal(result.ok && result.rowsRemoved, 0);
    assert.equal(index.rows.length, 1, "a dry run must not delete");
  });

  it("refuses when the publicId does not match, and keeps the row", async () => {
    // The publicId is the check. It cannot be produced without reading the row
    // and looking the asset up, which is the whole point of requiring it.
    const index = createFakeVideoIndex([STRANDED]);

    const result = await forgetVideo({
      index,
      id: "vid_1",
      confirmPublicId: "cloudinary/folder/something-else",
      dryRun: false,
    });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "public-id-mismatch");
    assert.equal(index.rows.length, 1);
  });

  it("reports a row that is not there rather than reporting success", async () => {
    const index = createFakeVideoIndex([]);

    const result = await forgetVideo({
      index,
      id: "vid_missing",
      confirmPublicId: "anything",
      dryRun: false,
    });

    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "not-found");
  });

  it("is not owner-scoped: it clears another account's stranded row", async () => {
    // It runs with the shell's authority, which is the only administrator
    // identity this app has. An owner-scoped version could not clear the rows
    // this exists for.
    const index = createFakeVideoIndex([
      videoRecord({ id: "vid_1", userId: "someone_else", publicId: "p/1" }),
    ]);

    const result = await forgetVideo({
      index,
      id: "vid_1",
      confirmPublicId: "p/1",
      dryRun: false,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(index.rows, []);
  });
});
