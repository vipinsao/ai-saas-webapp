import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  isValidImageId,
  isValidOwnerId,
  newImageId,
  readImage,
  resolveImagePath,
  saveImage,
} from "../lib/imageStore";

let root: string;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "imagestore-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("image id validation", () => {
  it("generates 32 lowercase hex characters", () => {
    const id = newImageId();
    assert.match(id, /^[0-9a-f]{32}$/);
    assert.ok(isValidImageId(id));
  });

  it("generates a different id each time", () => {
    assert.notEqual(newImageId(), newImageId());
  });

  for (const bad of ["", "../secret", "abc", "A".repeat(32), "0".repeat(31), "0".repeat(33)]) {
    it(`rejects ${JSON.stringify(bad)}`, () => {
      assert.equal(isValidImageId(bad), false);
    });
  }

  it("rejects owner ids containing path separators", () => {
    assert.equal(isValidOwnerId("../../etc"), false);
    assert.equal(isValidOwnerId("user_2abcDEF"), true);
  });
});

describe("resolveImagePath", () => {
  it("throws instead of escaping the storage root", () => {
    assert.throws(() => resolveImagePath("user_a", "../../../etc/passwd", root), /Invalid image id/);
    assert.throws(() => resolveImagePath("../../etc", newImageId(), root), /Invalid owner id/);
  });

  it("stays inside the storage root for valid input", () => {
    const resolved = resolveImagePath("user_a", newImageId(), root);
    assert.ok(resolved.startsWith(path.join(root, "user_a") + path.sep));
  });
});

describe("saveImage / readImage", () => {
  it("round-trips the bytes it was given", async () => {
    const id = newImageId();
    const payload = Buffer.from("not really an image, but bytes are bytes");
    await saveImage("user_a", id, payload, root);
    const read = await readImage("user_a", id, root);
    assert.deepEqual(read, payload);
  });

  it("returns null for an id that was never stored", async () => {
    assert.equal(await readImage("user_a", newImageId(), root), null);
  });

  it("does not return another user's file for the same id", async () => {
    const id = newImageId();
    await saveImage("user_a", id, Buffer.from("owner a"), root);
    // Same id, different caller: the path is built from the caller's id, so
    // there is nothing to read.
    assert.equal(await readImage("user_b", id, root), null);
  });

  it("cannot be tricked into reading a file outside the store", async () => {
    await mkdir(path.join(root, "user_a"), { recursive: true });
    await writeFile(path.join(root, "secret.txt"), "top secret");
    await assert.rejects(
      () => readImage("user_a", "../secret" as string, root),
      /Invalid image id/
    );
  });
});
