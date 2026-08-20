import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  deleteImage,
  isValidImageId,
  isValidOwnerId,
  listStoredImages,
  newImageId,
  readImage,
  resolveImagePath,
  saveImage,
  defaultStorageRoot,
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

describe("deleteImage", () => {
  it("removes the file and reports that it did", async () => {
    const id = newImageId();
    await saveImage("user_a", id, Buffer.from("bytes"), root);
    assert.equal(await deleteImage("user_a", id, root), true);
    assert.equal(await readImage("user_a", id, root), null);
  });

  it("reports false rather than throwing when there is nothing to remove", async () => {
    // A delete drops the index row first, so a retry -- or a delete of
    // something the reaper already collected -- legitimately finds no file.
    assert.equal(await deleteImage("user_a", newImageId(), root), false);
  });

  it("is idempotent", async () => {
    const id = newImageId();
    await saveImage("user_a", id, Buffer.from("bytes"), root);
    assert.equal(await deleteImage("user_a", id, root), true);
    assert.equal(await deleteImage("user_a", id, root), false);
  });

  it("cannot delete another user's file with the same id", async () => {
    const id = newImageId();
    await saveImage("user_a", id, Buffer.from("owner a"), root);
    // The path is built from the caller's own id, so there is nothing there.
    assert.equal(await deleteImage("user_b", id, root), false);
    assert.deepEqual(await readImage("user_a", id, root), Buffer.from("owner a"));
  });

  it("refuses to resolve a traversing id, leaving the target file untouched", async () => {
    // A traversal on delete is worse than on read: a read leaks a file, a
    // delete destroys one.
    const victim = path.join(root, "delete-me-not.txt");
    await writeFile(victim, "still here");
    for (const attack of [
      "../delete-me-not",
      "../../delete-me-not",
      "..%2Fdelete-me-not",
      "/etc/passwd",
      "\\..\\delete-me-not",
      `${newImageId()}/../../delete-me-not`,
      "0".repeat(31),
    ]) {
      await assert.rejects(() => deleteImage("user_a", attack, root), /Invalid image id/);
    }
    await assert.rejects(
      () => deleteImage("../../etc", newImageId(), root),
      /Invalid owner id/
    );
    assert.equal(await readFile(victim, "utf8"), "still here");
  });
});

describe("listStoredImages", () => {
  it("returns an empty list for a store that does not exist yet", async () => {
    assert.deepEqual(await listStoredImages(path.join(root, "no-such-dir")), []);
  });

  it("reports owner, id, size and mtime for each stored file", async () => {
    const scanRoot = await mkdtemp(path.join(tmpdir(), "imagescan-"));
    const id = newImageId();
    await saveImage("user_a", id, Buffer.from("12345"), scanRoot);
    const [found] = await listStoredImages(scanRoot);
    assert.equal(found.ownerId, "user_a");
    assert.equal(found.imageId, id);
    assert.equal(found.bytes, 5);
    assert.ok(found.modifiedAtMs > 0);
    await rm(scanRoot, { recursive: true, force: true });
  });

  it("ignores files and directories that are not part of the scheme", async () => {
    const scanRoot = await mkdtemp(path.join(tmpdir(), "imagescan-"));
    const id = newImageId();
    await saveImage("user_a", id, Buffer.from("real"), scanRoot);
    // Not ours: wrong extension, wrong id shape, and a directory that is not a
    // valid owner id. The reaper deletes what this returns, so anything it
    // cannot prove it named must not appear.
    await writeFile(path.join(scanRoot, "user_a", "notes.txt"), "unrelated");
    await writeFile(path.join(scanRoot, "user_a", "short.webp"), "unrelated");
    await mkdir(path.join(scanRoot, "..bad owner"), { recursive: true });
    await writeFile(path.join(scanRoot, "..bad owner", `${newImageId()}.webp`), "unrelated");

    const found = await listStoredImages(scanRoot);
    assert.deepEqual(
      found.map((file) => `${file.ownerId}/${file.imageId}`),
      [`user_a/${id}`]
    );
    await rm(scanRoot, { recursive: true, force: true });
  });

  it("reads the mtime the reaper's grace window compares against", async () => {
    const scanRoot = await mkdtemp(path.join(tmpdir(), "imagescan-"));
    const id = newImageId();
    await saveImage("user_a", id, Buffer.from("old"), scanRoot);
    const anHourAgo = new Date(Date.now() - 3600_000);
    await utimes(path.join(scanRoot, "user_a", `${id}.webp`), anHourAgo, anHourAgo);
    const [found] = await listStoredImages(scanRoot);
    assert.ok(Math.abs(found.modifiedAtMs - anHourAgo.getTime()) < 2000);
    await rm(scanRoot, { recursive: true, force: true });
  });
});

describe("defaultStorageRoot: a blank IMAGE_STORAGE_DIR is not configuration", () => {
  const original = process.env.IMAGE_STORAGE_DIR;
  const fallback = path.join(process.cwd(), "storage", "uploads");

  after(() => {
    if (original === undefined) delete process.env.IMAGE_STORAGE_DIR;
    else process.env.IMAGE_STORAGE_DIR = original;
  });

  it("falls back to ./storage/uploads when unset", () => {
    delete process.env.IMAGE_STORAGE_DIR;
    assert.equal(defaultStorageRoot(), fallback);
  });

  it("falls back when the value is the empty string .env.example ships", () => {
    // `cp .env.example .env` yields IMAGE_STORAGE_DIR="". Read with `??` that
    // resolved to "", so uploads landed in the process working directory and
    // the reaper refused every sweep. Blank means "use the default".
    process.env.IMAGE_STORAGE_DIR = "";
    assert.equal(defaultStorageRoot(), fallback);
  });

  it("falls back when the value is only whitespace", () => {
    process.env.IMAGE_STORAGE_DIR = "   ";
    assert.equal(defaultStorageRoot(), fallback);
  });

  it("still honours a real directory", () => {
    process.env.IMAGE_STORAGE_DIR = "/var/data/images";
    assert.equal(defaultStorageRoot(), "/var/data/images");
  });
});
