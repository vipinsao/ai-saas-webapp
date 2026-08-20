import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import {
  createVideoDeleteHandler,
  createVideoListHandler,
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

  it("destroys the remote asset and then removes the row, in that order", async () => {
    // Reversed, a crash in between would strand the asset in Cloudinary with
    // nothing left able to name it. The order is asserted, not assumed.
    const { index, handler } = remove("user_a");
    const order: string[] = [];
    const innerDestroy = cloudinary.destroyVideo.bind(cloudinary);
    cloudinary.destroyVideo = async (publicId) => {
      order.push("destroy");
      return innerDestroy(publicId);
    };
    const innerDelete = index.deleteOwned.bind(index);
    index.deleteOwned = async (userId, id) => {
      order.push("row");
      return innerDelete(userId, id);
    };

    const response = await handler(request(), context("vid_1"));

    assert.equal(response.status, 200);
    assert.deepEqual(order, ["destroy", "row"]);
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

describe("GET /api/videos: signed delivery, no publicId (regression, H8)", () => {
  function seeded() {
    return createFakeVideoIndex([
      videoRecord({ id: "vid_1", userId: "user_a", publicId: "video-uploads/mine", title: "Mine" }),
      videoRecord({ id: "vid_2", userId: "user_b", publicId: "video-uploads/theirs" }),
    ]);
  }

  it("never puts publicId in the response as a field of its own", async () => {
    // While the list query was unscoped, every account received every other
    // account's publicId -- and because uploads were public delivery, that id
    // was on its own a working download link.
    //
    // Note what is NOT claimed here: a delivery URL necessarily contains the
    // public id, so the string is still on the wire and pretending otherwise
    // would be theatre. Two separate things fix this. The id is no longer a
    // field the client reads or forwards, and -- the part that actually
    // matters -- `type: "authenticated"` means holding the id buys nothing
    // without a signature only this server can compute. That property is
    // asserted in the suite below.
    const list = createVideoListHandler({
      auth: signedInAs("user_a"),
      index: seeded(),
      cloudinary: provider(),
    });

    const body = await (await list()).json();

    assert.equal(body.length, 1);
    assert.equal(body[0].publicId, undefined);
    assert.deepEqual(Object.keys(body[0]).sort(), [
      "compressedSize",
      "createdAt",
      "description",
      "downloadUrl",
      "duration",
      "id",
      "originalSize",
      "previewUrl",
      "thumbnailUrl",
      "title",
    ]);
  });

  it("lists only the caller's videos", async () => {
    const list = createVideoListHandler({
      auth: signedInAs("user_a"),
      index: seeded(),
      cloudinary: provider(),
    });
    const body = await (await list()).json();
    assert.deepEqual(body.map((v: { id: string }) => v.id), ["vid_1"]);
  });

  it("hands out the three signed URLs the card needs", async () => {
    const list = createVideoListHandler({
      auth: signedInAs("user_a"),
      index: seeded(),
      cloudinary: provider(),
    });
    const [video] = await (await list()).json();
    assert.match(video.thumbnailUrl, /sig=/);
    assert.match(video.previewUrl, /sig=/);
    assert.match(video.downloadUrl, /sig=/);
  });

  it("answers 503 rather than a list of dead links when unconfigured", async () => {
    const list = createVideoListHandler({
      auth: signedInAs("user_a"),
      index: seeded(),
      cloudinary: () => envCloudinaryProvider({}),
    });
    assert.equal((await list()).status, 503);
  });

  it("rejects an anonymous caller with 401", async () => {
    const list = createVideoListHandler({
      auth: signedInAs(null),
      index: seeded(),
      cloudinary: provider(),
    });
    assert.equal((await list()).status, 401);
  });

  it("does not return publicId from the upload response either", async () => {
    const index = createFakeVideoIndex();
    const upload = createVideoUploadHandler({
      auth: signedInAs("user_a"),
      index,
      cloudinary: provider(),
      limiter: permissiveLimiter(),
    });
    const body = await (await upload(uploadRequest())).json();
    assert.equal(body.publicId, undefined);
    assert.match(body.downloadUrl, /sig=/);
  });
});

describe("Cloudinary asset type (regression, H8)", () => {
  it("signs URLs against the authenticated delivery type, not public upload", async () => {
    // Verified locally: signature generation is an HMAC over the transformation
    // and the public id, so it can be asserted here. Whether Cloudinary ACCEPTS
    // the signature is not verified -- no live account was ever used.
    const resolved = envCloudinaryProvider(CONFIGURED);
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;

    const urls = resolved.client.videoUrls("video-uploads/abc", "My Holiday Clip!");

    for (const url of Object.values(urls)) {
      assert.match(url, /\/video\/authenticated\//, "must not be the public /video/upload/ path");
      assert.match(url, /\/s--[A-Za-z0-9_-]+--\//, "must carry a signature segment");
    }
    assert.match(urls.downloadUrl, /fl_attachment:My-Holiday-Clip/);
    assert.match(urls.thumbnailUrl, /\.jpg/);
    assert.match(urls.previewUrl, /e_preview:duration_15/);
  });

  it("binds the signature to the API secret", async () => {
    const a = envCloudinaryProvider(CONFIGURED);
    const b = envCloudinaryProvider({ ...CONFIGURED, CLOUDINARY_API_SECRET: "a-different-secret" });
    assert.equal(a.ok && b.ok, true);
    if (!a.ok || !b.ok) return;
    assert.notEqual(
      a.client.videoUrls("video-uploads/abc", "t").thumbnailUrl,
      b.client.videoUrls("video-uploads/abc", "t").thumbnailUrl
    );
  });

  it("uploads as authenticated so a bare publicId is not a download link", async () => {
    const seen: Record<string, unknown>[] = [];
    const { v2 } = await import("cloudinary");
    const original = v2.uploader.upload_stream;
    // Intercept at the SDK boundary: what matters is the options object that
    // reaches Cloudinary, which the fake client cannot show.
    (v2.uploader as unknown as { upload_stream: unknown }).upload_stream = ((
      options: Record<string, unknown>,
      callback: (e: unknown, r: unknown) => void
    ) => {
      seen.push(options);
      return {
        end: () => callback(null, { public_id: "video-uploads/x", bytes: 1, duration: 1 }),
      };
    }) as unknown as typeof original;

    try {
      const resolved = envCloudinaryProvider(CONFIGURED);
      assert.equal(resolved.ok, true);
      if (!resolved.ok) return;
      await resolved.client.uploadVideo(Buffer.alloc(4), { folder: VIDEO_FOLDER });
      assert.equal(seen[0].type, "authenticated");
      assert.equal(seen[0].resource_type, "video");
      assert.equal(seen[0].folder, VIDEO_FOLDER);
    } finally {
      (v2.uploader as unknown as { upload_stream: unknown }).upload_stream = original;
    }
  });

  it("destroys with the same resource_type and type it uploaded with", async () => {
    // A destroy whose `type` does not match the upload answers "not found" and
    // leaves the asset in place -- a delete that reports success and deletes
    // nothing, which is the exact bug the delete ordering was written to fix.
    const seen: Array<[string, Record<string, unknown>]> = [];
    const { v2 } = await import("cloudinary");
    const original = v2.uploader.destroy;
    (v2.uploader as unknown as { destroy: unknown }).destroy = (async (
      publicId: string,
      options: Record<string, unknown>
    ) => {
      seen.push([publicId, options]);
      return { result: "ok" };
    }) as unknown as typeof original;

    try {
      const resolved = envCloudinaryProvider(CONFIGURED);
      assert.equal(resolved.ok, true);
      if (!resolved.ok) return;
      await resolved.client.destroyVideo("video-uploads/abc");
      assert.deepEqual(seen[0][1], { resource_type: "video", type: "authenticated" });
    } finally {
      (v2.uploader as unknown as { destroy: unknown }).destroy = original;
    }
  });
});
