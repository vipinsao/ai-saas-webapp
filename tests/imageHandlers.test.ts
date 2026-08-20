import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import {
  createImageDeleteHandler,
  createImageListHandler,
  createImageTransformHandler,
  createImageUploadHandler,
} from "../lib/handlers/images";
import { listStoredImages, newImageId, readImage, saveImage } from "../lib/imageStore";
import { createFakeImageIndex, imageRecord, permissiveLimiter, signedInAs } from "./support/fakes";

/**
 * These drive the same functions the route files export -- app/api/images/[id]/route.ts
 * is `export const DELETE = createImageDeleteHandler(...)` and nothing else --
 * against an in-memory index and a temp storage directory. No Postgres, no
 * Clerk, no network.
 */

// Resolved from the repo root: the test script is always run from there.
const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "landscape.png");

let root: string;
let fixture: Buffer;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "imagehandler-"));
  fixture = await readFile(FIXTURE);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function uploadRequest(bytes: Buffer, type = "image/png"): NextRequest {
  const body = new FormData();
  body.append("file", new File([new Uint8Array(bytes)], "photo.png", { type }));
  return new NextRequest("http://localhost/api/image-upload", { method: "POST", body });
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/image-upload", () => {
  it("writes the file and the row, and reports the stored size", async () => {
    const index = createFakeImageIndex();
    const upload = createImageUploadHandler({
      auth: signedInAs("user_a"),
      index,
      root,
      limiter: permissiveLimiter(),
    });

    const response = await upload(uploadRequest(fixture));
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(index.rows.length, 1);
    assert.equal(index.rows[0].id, body.id);
    assert.equal(index.rows[0].userId, "user_a");
    assert.equal(index.rows[0].bytes, body.bytes);
    assert.equal(index.rows[0].originalBytes, fixture.length);

    const stored = await readImage("user_a", body.id, root);
    assert.notEqual(stored, null);
    assert.equal(stored!.length, body.bytes, "the row's byte count is the file's real size");
  });

  it("removes the file it just wrote when the row cannot be written", async () => {
    // Otherwise the failed request leaves bytes on disk that nothing points at
    // and no user can ever delete -- the exact leak this work is about.
    const index = createFakeImageIndex();
    index.failNextCreate = true;
    const upload = createImageUploadHandler({
      auth: signedInAs("user_a"),
      index,
      root,
      limiter: permissiveLimiter(),
    });

    const response = await upload(uploadRequest(fixture));

    assert.equal(response.status, 500);
    assert.equal(index.rows.length, 0);
    assert.deepEqual(await listStoredImages(root), []);
  });

  it("rejects a decode bomb in milliseconds, not seconds (regression, C1)", async () => {
    // 119 bytes of SVG declared as image/png. validateUpload passed it -- it
    // only ever saw the declared type and the size -- and sharp then spent
    // 4967 ms rasterising 8000x8000. At 10 uploads per minute per user that is
    // 50 seconds of CPU per user per minute from a 119-byte request.
    const bomb = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="8000"><rect width="100%" height="100%" fill="#f00"/></svg>'
    );
    const index = createFakeImageIndex();
    const upload = createImageUploadHandler({
      auth: signedInAs("user_a"),
      index,
      root,
      limiter: permissiveLimiter(),
    });

    const startedAt = Date.now();
    const response = await upload(uploadRequest(bomb, "image/png"));
    const elapsed = Date.now() - startedAt;

    assert.equal(response.status, 415);
    assert.match((await response.json()).error, /SVG is not supported/);
    assert.ok(elapsed < 2000, `took ${elapsed} ms; the bomb decoded in 4967 ms`);
    assert.equal(index.rows.length, 0);
    assert.deepEqual(await listStoredImages(root), []);
  });

  it("rejects bytes that are not any supported image, whatever the type says", async () => {
    const index = createFakeImageIndex();
    const upload = createImageUploadHandler({
      auth: signedInAs("user_a"),
      index,
      root,
      limiter: permissiveLimiter(),
    });

    for (const payload of ["%PDF-1.7 ...", "<!DOCTYPE html><html></html>", "PK\x03\x04"]) {
      const response = await upload(uploadRequest(Buffer.from(payload), "image/png"));
      assert.equal(response.status, 415, payload.slice(0, 12));
    }
    assert.deepEqual(await listStoredImages(root), []);
  });

  it("rejects an anonymous caller before reading the body", async () => {
    const index = createFakeImageIndex();
    const upload = createImageUploadHandler({
      auth: signedInAs(null),
      index,
      root,
      limiter: permissiveLimiter(),
    });

    const response = await upload(uploadRequest(fixture));

    assert.equal(response.status, 401);
    assert.deepEqual(await listStoredImages(root), []);
  });
});

describe("per-user storage quota", () => {
  it("rejects the upload with 507 once the quota is used up", async () => {
    const index = createFakeImageIndex([
      imageRecord({ id: newImageId(), userId: "user_a", bytes: 900 }),
    ]);
    const upload = createImageUploadHandler({
      auth: signedInAs("user_a"),
      index,
      root,
      quotaBytes: 1000,
      limiter: permissiveLimiter(),
    });

    const response = await upload(uploadRequest(fixture));

    assert.equal(response.status, 507);
    const body = await response.json();
    assert.match(body.error, /Storage quota exceeded/);
    assert.equal(body.quotaBytes, 1000);
    assert.equal(body.usedBytes, 900);
  });

  it("writes nothing to disk when the quota rejects the upload", async () => {
    const index = createFakeImageIndex([
      imageRecord({ id: newImageId(), userId: "user_a", bytes: 1000 }),
    ]);
    const upload = createImageUploadHandler({
      auth: signedInAs("user_a"),
      index,
      root,
      quotaBytes: 1000,
      limiter: permissiveLimiter(),
    });

    await upload(uploadRequest(fixture));

    assert.deepEqual(await listStoredImages(root), []);
    assert.equal(index.rows.length, 1, "the pre-existing row is untouched");
  });

  it("counts only the caller's own bytes", async () => {
    // A shared counter would let a busy neighbour lock everyone else out.
    const index = createFakeImageIndex([
      imageRecord({ id: newImageId(), userId: "user_b", bytes: 10_000 }),
    ]);
    const upload = createImageUploadHandler({
      auth: signedInAs("user_a"),
      index,
      root,
      quotaBytes: 10_000_000,
      limiter: permissiveLimiter(),
    });

    const response = await upload(uploadRequest(fixture));

    assert.equal(response.status, 200);
  });

  it("frees space again once an image is deleted", async () => {
    const index = createFakeImageIndex();
    const deps = { auth: signedInAs("user_a"), index, root, limiter: permissiveLimiter() };
    const upload = createImageUploadHandler({ ...deps, quotaBytes: 10_000_000 });
    const first = await (await upload(uploadRequest(fixture))).json();

    const usedAfterUpload = await index.usedBytes("user_a");
    assert.ok(usedAfterUpload > 0);

    const remove = createImageDeleteHandler(deps);
    await remove(new NextRequest("http://localhost/api/images/x", { method: "DELETE" }), context(first.id));

    assert.equal(await index.usedBytes("user_a"), 0);
  });
});

describe("DELETE /api/images/:id", () => {
  function handler(userId: string | null, index = createFakeImageIndex()) {
    return {
      index,
      remove: createImageDeleteHandler({ auth: signedInAs(userId), index, root }),
    };
  }

  function deleteRequest() {
    return new NextRequest("http://localhost/api/images/x", { method: "DELETE" });
  }

  it("removes the row and the file", async () => {
    const id = newImageId();
    await saveImage("user_a", id, Buffer.from("bytes"), root);
    const { index, remove } = handler("user_a", createFakeImageIndex([imageRecord({ id, userId: "user_a" })]));

    const response = await remove(deleteRequest(), context(id));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id, deleted: true, fileRemoved: true });
    assert.equal(index.rows.length, 0);
    assert.equal(await readImage("user_a", id, root), null);
  });

  it("deletes the row before the file, not after", async () => {
    // The ordering is the whole crash-consistency argument, so it is pinned
    // here rather than left to a comment: at the moment the row is removed the
    // file must still be on disk. Swap the two statements in the handler and
    // this fails.
    const id = newImageId();
    await saveImage("user_a", id, Buffer.from("bytes"), root);
    const index = createFakeImageIndex([imageRecord({ id, userId: "user_a" })]);

    let fileStillPresentWhenRowWent: boolean | null = null;
    const inner = index.deleteOwned.bind(index);
    index.deleteOwned = async (userId, imageId) => {
      fileStillPresentWhenRowWent = (await readImage("user_a", id, root)) !== null;
      return inner(userId, imageId);
    };

    const { remove } = handler("user_a", index);
    await remove(deleteRequest(), context(id));

    assert.equal(fileStillPresentWhenRowWent, true);
    assert.equal(await readImage("user_a", id, root), null, "and the file goes after");
  });

  it("still succeeds when the row is there but the file has already gone", async () => {
    // The reaper may have collected it, or a previous delete may have crashed
    // between the two statements. Either way the end state is what was asked
    // for, so this is not an error.
    const id = newImageId();
    const { index, remove } = handler("user_a", createFakeImageIndex([imageRecord({ id, userId: "user_a" })]));

    const response = await remove(deleteRequest(), context(id));

    assert.equal(response.status, 200);
    assert.equal((await response.json()).fileRemoved, false);
    assert.equal(index.rows.length, 0);
  });

  it("answers 404, not 403, for another user's image", async () => {
    // 403 would confirm the id exists. The file must survive, too.
    const id = newImageId();
    await saveImage("user_a", id, Buffer.from("owner a"), root);
    const index = createFakeImageIndex([imageRecord({ id, userId: "user_a" })]);
    const { remove } = handler("user_b", index);

    const response = await remove(deleteRequest(), context(id));

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Image not found" });
    assert.equal(index.rows.length, 1);
    assert.notEqual(await readImage("user_a", id, root), null);
  });

  it("answers 404 for an id that never existed", async () => {
    const { remove } = handler("user_a");
    const response = await remove(deleteRequest(), context(newImageId()));
    assert.equal(response.status, 404);
  });

  it("rejects an anonymous caller with 401", async () => {
    const id = newImageId();
    const index = createFakeImageIndex([imageRecord({ id, userId: "user_a" })]);
    const { remove } = handler(null, index);

    const response = await remove(deleteRequest(), context(id));

    assert.equal(response.status, 401);
    assert.equal(index.rows.length, 1);
  });

  it("rejects a traversing id with 400 and destroys nothing", async () => {
    // A delete endpoint is a far more dangerous traversal target than a read:
    // a read leaks a file, a delete destroys one. Next has already
    // percent-decoded the segment by the time the handler sees it, so the
    // decoded forms are what must be rejected.
    const outside = path.join(root, "important.txt");
    await writeFile(outside, "do not delete");
    const { remove } = handler("user_a");

    for (const attack of [
      "../important",
      "../../important",
      "..%2fimportant",
      "....//important",
      "/etc/passwd",
      "..\\important",
      `${newImageId()}/../../important`,
      "",
      ".",
    ]) {
      const response = await remove(deleteRequest(), context(attack));
      assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(attack)}`);
      assert.deepEqual(await response.json(), { error: "Invalid image id" });
    }

    assert.equal(await readFile(outside, "utf8"), "do not delete");
  });
});

describe("GET /api/images/:id", () => {
  it("serves a crop of the caller's own image", async () => {
    const id = newImageId();
    await saveImage("user_a", id, fixture, root);
    const index = createFakeImageIndex([imageRecord({ id, userId: "user_a" })]);
    const get = createImageTransformHandler({
      auth: signedInAs("user_a"),
      index,
      root,
      limiter: permissiveLimiter(),
    });

    const response = await get(
      new NextRequest(`http://localhost/api/images/${id}?format=instagram-square`),
      context(id)
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "image/webp");
    assert.equal(response.headers.get("Cache-Control"), "private, max-age=3600");
  });

  it("stops serving an image as soon as its row is gone, before the file is", async () => {
    // The delete removes the row first, so for a moment the bytes are still on
    // disk. Reading from disk alone would keep handing out deleted content.
    const id = newImageId();
    await saveImage("user_a", id, fixture, root);
    const index = createFakeImageIndex();
    const get = createImageTransformHandler({
      auth: signedInAs("user_a"),
      index,
      root,
      limiter: permissiveLimiter(),
    });

    const response = await get(
      new NextRequest(`http://localhost/api/images/${id}?format=instagram-square`),
      context(id)
    );

    assert.equal(response.status, 404);
    assert.notEqual(await readImage("user_a", id, root), null, "the file is still there");
  });

  it("does not serve another user's image", async () => {
    const id = newImageId();
    await saveImage("user_a", id, fixture, root);
    const index = createFakeImageIndex([imageRecord({ id, userId: "user_a" })]);
    const get = createImageTransformHandler({
      auth: signedInAs("user_b"),
      index,
      root,
      limiter: permissiveLimiter(),
    });

    const response = await get(
      new NextRequest(`http://localhost/api/images/${id}?format=instagram-square`),
      context(id)
    );

    assert.equal(response.status, 404);
  });
});

describe("GET /api/images", () => {
  it("lists only the caller's images with their quota position", async () => {
    const mine = newImageId();
    const theirs = newImageId();
    const index = createFakeImageIndex([
      imageRecord({ id: mine, userId: "user_a", bytes: 400 }),
      imageRecord({ id: theirs, userId: "user_b", bytes: 900 }),
    ]);
    const list = createImageListHandler({
      auth: signedInAs("user_a"),
      index,
      root,
      quotaBytes: 1000,
    });

    const body = await (await list()).json();

    assert.deepEqual(body.images.map((image: { id: string }) => image.id), [mine]);
    assert.deepEqual(body.usage, { usedBytes: 400, quotaBytes: 1000, remainingBytes: 600 });
  });

  it("rejects an anonymous caller with 401", async () => {
    const list = createImageListHandler({
      auth: signedInAs(null),
      index: createFakeImageIndex(),
      root,
    });
    assert.equal((await list()).status, 401);
  });
});
