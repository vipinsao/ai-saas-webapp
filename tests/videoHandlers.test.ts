import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import {
  createVideoDeleteHandler,
  createVideoUploadHandler,
  envCloudinaryProvider,
  VIDEO_FOLDER,
  type CloudinaryProvider,
} from "../lib/handlers/videos";
import {
  createFakeCloudinary,
  createFakeVideoIndex,
  permissiveLimiter,
  signedInAs,
  silenceConsoleError,
  videoRecord,
  type FakeCloudinary,
} from "./support/fakes";

/**
 * The video path against a fake Cloudinary.
 *
 * HONEST SCOPE: this proves the handler -- ordering, status codes, ownership,
 * what is written and what is undone. It does NOT prove that the real
 * Cloudinary SDK behaves as the fake does, because no live Cloudinary account
 * was ever used. The parts that remain unverified against the real service are
 * listed in DECISIONS.md under "What the video tests do not prove".
 */

const CONFIGURED = {
  NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME: "demo-cloud",
  CLOUDINARY_API_KEY: "123",
  CLOUDINARY_API_SECRET: "s3cr3t",
};

let cloudinary: FakeCloudinary;
let restoreConsole: () => void;

beforeEach(() => {
  cloudinary = createFakeCloudinary();
  restoreConsole = silenceConsoleError();
});

afterEach(() => {
  restoreConsole();
});

function provider(): CloudinaryProvider {
  return () => ({ ok: true as const, client: cloudinary });
}

function uploadRequest(options: {
  bytes?: number;
  type?: string;
  title?: string | null;
  description?: string | null;
  omitFile?: boolean;
} = {}) {
  const body = new FormData();
  if (!options.omitFile) {
    const size = options.bytes ?? 2048;
    body.append(
      "file",
      new File([new Uint8Array(size)], "clip.mp4", { type: options.type ?? "video/mp4" })
    );
  }
  if (options.title !== null) body.append("title", options.title ?? "Holiday clip");
  if (options.description !== null) {
    body.append("description", options.description ?? "A short clip");
  }
  return new NextRequest("http://localhost/api/video-upload", { method: "POST", body });
}

function context(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("POST /api/video-upload: the happy path", () => {
  it("uploads to the video folder and records the row against the caller", async () => {
    const index = createFakeVideoIndex();
    const upload = createVideoUploadHandler({
      auth: signedInAs("user_a"),
      index,
      cloudinary: provider(),
      limiter: permissiveLimiter(),
    });

    const response = await upload(uploadRequest({ bytes: 4096 }));

    assert.equal(response.status, 200);
    assert.deepEqual(cloudinary.uploads, [{ bytes: 4096, folder: VIDEO_FOLDER }]);
    assert.equal(index.rows.length, 1);
    assert.equal(index.rows[0].userId, "user_a");
    assert.equal(index.rows[0].publicId, "video-uploads/abc");
    assert.equal(index.rows[0].title, "Holiday clip");
  });

  it("measures both sizes server-side rather than trusting the form", async () => {
    // The original size used to come from a form field, so the compression
    // figure shown to the user was whatever the client claimed.
    const index = createFakeVideoIndex();
    cloudinary.nextResult = { public_id: "video-uploads/xyz", bytes: 700, duration: 42.5 };
    const upload = createVideoUploadHandler({
      auth: signedInAs("user_a"),
      index,
      cloudinary: provider(),
      limiter: permissiveLimiter(),
    });

    await upload(uploadRequest({ bytes: 5000 }));

    assert.equal(index.rows[0].originalSize, "5000", "measured from the received bytes");
    assert.equal(index.rows[0].compressedSize, "700", "taken from Cloudinary's answer");
    assert.equal(index.rows[0].duration, 42.5);
  });

  it("defaults duration to 0 when Cloudinary does not report one", async () => {
    const index = createFakeVideoIndex();
    cloudinary.nextResult = { public_id: "video-uploads/xyz", bytes: 700 };
    const upload = createVideoUploadHandler({
      auth: signedInAs("user_a"),
      index,
      cloudinary: provider(),
      limiter: permissiveLimiter(),
    });

    await upload(uploadRequest());

    assert.equal(index.rows[0].duration, 0);
  });

  it("stores an omitted description as null, not as an empty string", async () => {
    const index = createFakeVideoIndex();
    const upload = createVideoUploadHandler({
      auth: signedInAs("user_a"),
      index,
      cloudinary: provider(),
      limiter: permissiveLimiter(),
    });

    await upload(uploadRequest({ description: null }));

    assert.equal(index.rows[0].description, null);
  });
});

describe("POST /api/video-upload: who is allowed to", () => {
  it("rejects an anonymous caller and uploads nothing", async () => {
    const index = createFakeVideoIndex();
    const upload = createVideoUploadHandler({
      auth: signedInAs(null),
      index,
      cloudinary: provider(),
      limiter: permissiveLimiter(),
    });

    const response = await upload(uploadRequest());

    assert.equal(response.status, 401);
    assert.deepEqual(cloudinary.uploads, []);
    assert.equal(index.rows.length, 0);
  });

  it("stamps the row with the session's user, not anything from the form", async () => {
    const index = createFakeVideoIndex();
    const body = new FormData();
    body.append("file", new File([new Uint8Array(10)], "clip.mp4", { type: "video/mp4" }));
    body.append("title", "Mine");
    body.append("userId", "user_victim");
    const upload = createVideoUploadHandler({
      auth: signedInAs("user_attacker"),
      index,
      cloudinary: provider(),
      limiter: permissiveLimiter(),
    });

    await upload(
      new NextRequest("http://localhost/api/video-upload", { method: "POST", body })
    );

    assert.equal(index.rows[0].userId, "user_attacker");
  });

  it("returns 429 when the limiter says the user has had enough", async () => {
    const index = createFakeVideoIndex();
    const limiter = { check: () => ({ allowed: false, remaining: 0, retryAfterSeconds: 30 }) };
    const upload = createVideoUploadHandler({
      auth: signedInAs("user_a"),
      index,
      cloudinary: provider(),
      limiter,
    });

    const response = await upload(uploadRequest());

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "30");
    assert.deepEqual(cloudinary.uploads, []);
  });
});

describe("POST /api/video-upload: the request is wrong", () => {
  function upload(index = createFakeVideoIndex()) {
    return createVideoUploadHandler({
      auth: signedInAs("user_a"),
      index,
      cloudinary: provider(),
      limiter: permissiveLimiter(),
    });
  }

  it("rejects a missing file with 400", async () => {
    const response = await upload()(uploadRequest({ omitFile: true }));
    assert.equal(response.status, 400);
  });

  it("rejects an image posing as a video with 415", async () => {
    const response = await upload()(uploadRequest({ type: "image/png" }));
    assert.equal(response.status, 415);
    assert.deepEqual(cloudinary.uploads, []);
  });

  it("applies the video size rules, not the image ones", async () => {
    // 11 MB is over the 10 MB image cap and well under the 200 MB video cap, so
    // this fails if the handler is wired to the wrong rule set. The 413 itself
    // is asserted directly against validateUpload in uploadValidation.test.ts;
    // building a 200 MB multipart body here would only prove FormData works.
    const index = createFakeVideoIndex();
    const response = await upload(index)(uploadRequest({ bytes: 11 * 1024 * 1024 }));

    assert.equal(response.status, 200);
    assert.equal(index.rows.length, 1);
  });

  it("rejects a missing title with 400 instead of failing on a NOT NULL column", async () => {
    const response = await upload()(uploadRequest({ title: null }));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /title is required/i);
  });

  it("rejects a blank title", async () => {
    const response = await upload()(uploadRequest({ title: "   " }));
    assert.equal(response.status, 400);
  });

  it("rejects an over-long title and description", async () => {
    assert.equal((await upload()(uploadRequest({ title: "t".repeat(201) }))).status, 400);
    assert.equal(
      (await upload()(uploadRequest({ description: "d".repeat(2001) }))).status,
      400
    );
  });
});

describe("POST /api/video-upload: Cloudinary is not configured", () => {
  it("answers 503 naming the missing variables, before reading the body", async () => {
    const index = createFakeVideoIndex();
    const upload = createVideoUploadHandler({
      auth: signedInAs("user_a"),
      index,
      cloudinary: () => envCloudinaryProvider({}),
      limiter: permissiveLimiter(),
    });

    const response = await upload(uploadRequest());

    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(body.missing, [
      "NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME",
      "CLOUDINARY_API_KEY",
      "CLOUDINARY_API_SECRET",
    ]);
    assert.match(body.error, /not configured/);
    assert.equal(index.rows.length, 0);
  });

  it("proceeds when the environment is complete", async () => {
    // envCloudinaryProvider builds a real SDK client here; the test stops at
    // the point where it would make a network call, so nothing is sent.
    const resolved = envCloudinaryProvider(CONFIGURED);
    assert.equal(resolved.ok, true);
  });
});

describe("POST /api/video-upload: Cloudinary fails", () => {
  function upload(index = createFakeVideoIndex()) {
    return createVideoUploadHandler({
      auth: signedInAs("user_a"),
      index,
      cloudinary: provider(),
      limiter: permissiveLimiter(),
    });
  }

  it("turns bad credentials into a 502 that names them", async () => {
    const index = createFakeVideoIndex();
    cloudinary.uploadError = { message: "Invalid Signature", http_code: 401 };

    const response = await upload(index)(uploadRequest());

    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /rejected the configured credentials/);
    assert.equal(index.rows.length, 0, "no row for an upload that never happened");
  });

  it("turns a rejected file into a 400 carrying Cloudinary's reason", async () => {
    cloudinary.uploadError = { message: "Video file is corrupt", http_code: 400 };
    const response = await upload()(uploadRequest());
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Video file is corrupt/);
  });

  it("turns a rate limit into a 429", async () => {
    cloudinary.uploadError = { message: "Rate limit reached", http_code: 420 };
    assert.equal((await upload()(uploadRequest())).status, 429);
  });

  it("turns an unreachable network into a 502 that says so", async () => {
    cloudinary.uploadError = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
      code: "ENOTFOUND",
    });
    const response = await upload()(uploadRequest());
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /Could not reach Cloudinary/);
  });

  it("deletes the uploaded asset when the row cannot be written", async () => {
    // publicId lives only in the row. Without this the asset would sit in
    // Cloudinary billed to the account with nothing left that could name it.
    const index = createFakeVideoIndex();
    index.failNextCreate = true;

    const response = await upload(index)(uploadRequest());

    assert.equal(response.status, 500);
    assert.equal(index.rows.length, 0);
    assert.deepEqual(cloudinary.destroyed, ["video-uploads/abc"]);
  });
});

describe("DELETE /api/videos/:id", () => {
  function seeded() {
    return createFakeVideoIndex([
      videoRecord({ id: "vid_1", userId: "user_a", publicId: "video-uploads/abc" }),
    ]);
  }

  function remove(userId: string | null, index = seeded(), cloud = provider()) {
    return {
      index,
      handler: createVideoDeleteHandler({ auth: signedInAs(userId), index, cloudinary: cloud }),
    };
  }

  function request() {
    return new NextRequest("http://localhost/api/videos/vid_1", { method: "DELETE" });
  }

  it("destroys the remote asset and then removes the row", async () => {
    const { index, handler } = remove("user_a");

    const response = await handler(request(), context("vid_1"));

    assert.equal(response.status, 200);
    assert.deepEqual(cloudinary.destroyed, ["video-uploads/abc"]);
    assert.equal(index.rows.length, 0);
  });

  it("keeps the row when the remote delete fails, so the asset can still be found", async () => {
    // The row holds the only copy of publicId. Dropping it here would strand
    // the asset in Cloudinary permanently.
    const { index, handler } = remove("user_a");
    cloudinary.destroyError = Object.assign(new Error("network down"), { code: "ECONNREFUSED" });

    const response = await handler(request(), context("vid_1"));

    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /The video was not deleted/);
    assert.equal(index.rows.length, 1);
  });

  it("removes the row when Cloudinary says the asset was already gone", async () => {
    // The self-healing retry after a crash between the two steps.
    const { index, handler } = remove("user_a");
    cloudinary.destroyResult = { result: "not found" };

    const response = await handler(request(), context("vid_1"));

    assert.equal(response.status, 200);
    assert.equal((await response.json()).remoteResult, "not found");
    assert.equal(index.rows.length, 0);
  });

  it("answers 404, not 403, for another user's video and touches nothing", async () => {
    const { index, handler } = remove("user_b");

    const response = await handler(request(), context("vid_1"));

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Video not found" });
    assert.deepEqual(cloudinary.destroyed, []);
    assert.equal(index.rows.length, 1);
  });

  it("answers 404 for an id that does not exist", async () => {
    const { handler } = remove("user_a");
    assert.equal((await handler(request(), context("vid_missing"))).status, 404);
  });

  it("rejects an anonymous caller with 401", async () => {
    const { index, handler } = remove(null);
    assert.equal((await handler(request(), context("vid_1"))).status, 401);
    assert.equal(index.rows.length, 1);
  });

  it("refuses to delete the row at all when Cloudinary is not configured", async () => {
    // Deleting only the row would leave the asset behind with nothing able to
    // name it -- exactly the leak this handler exists to close.
    const { index, handler } = remove("user_a", seeded(), () => envCloudinaryProvider({}));

    const response = await handler(request(), context("vid_1"));

    assert.equal(response.status, 503);
    assert.equal(index.rows.length, 1);
  });
});
