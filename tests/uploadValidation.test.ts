import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IMAGE_UPLOAD_RULES,
  MAX_IMAGE_BYTES,
  VIDEO_UPLOAD_RULES,
  formatBytes,
  validateUpload,
} from "../lib/uploadValidation";

describe("validateUpload", () => {
  it("accepts an allowed type within the size cap", () => {
    const result = validateUpload({ type: "image/png", size: 1024 }, IMAGE_UPLOAD_RULES);
    assert.deepEqual(result, { ok: true });
  });

  it("rejects a missing file with 400", () => {
    const result = validateUpload(null, IMAGE_UPLOAD_RULES);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.status, 400);
  });

  it("rejects a disallowed type with 415 and names the type", () => {
    const result = validateUpload(
      { type: "application/x-msdownload", size: 1024 },
      IMAGE_UPLOAD_RULES
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 415);
    assert.match(result.error, /application\/x-msdownload/);
  });

  it("rejects a video mime type on the image endpoint", () => {
    const result = validateUpload({ type: "video/mp4", size: 1024 }, IMAGE_UPLOAD_RULES);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.status, 415);
  });

  it("rejects an empty file", () => {
    const result = validateUpload({ type: "image/png", size: 0 }, IMAGE_UPLOAD_RULES);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.status, 400);
  });

  it("rejects an oversized file with 413 and states the limit", () => {
    const result = validateUpload(
      { type: "image/png", size: MAX_IMAGE_BYTES + 1 },
      IMAGE_UPLOAD_RULES
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 413);
    assert.match(result.error, /Maximum is 10MB/);
  });

  it("accepts a file exactly on the limit", () => {
    const result = validateUpload(
      { type: "image/png", size: MAX_IMAGE_BYTES },
      IMAGE_UPLOAD_RULES
    );
    assert.deepEqual(result, { ok: true });
  });

  it("uses a larger cap for video", () => {
    assert.ok(VIDEO_UPLOAD_RULES.maxBytes > IMAGE_UPLOAD_RULES.maxBytes);
    const result = validateUpload(
      { type: "video/mp4", size: MAX_IMAGE_BYTES + 1 },
      VIDEO_UPLOAD_RULES
    );
    assert.deepEqual(result, { ok: true });
  });
});

describe("formatBytes", () => {
  it("prints whole megabytes without decimals", () => {
    assert.equal(formatBytes(10 * 1024 * 1024), "10MB");
  });

  it("prints one decimal otherwise", () => {
    assert.equal(formatBytes(1_572_864), "1.5MB");
  });
});
