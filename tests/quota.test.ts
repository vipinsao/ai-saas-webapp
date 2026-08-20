import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkQuota,
  DEFAULT_STORAGE_QUOTA_BYTES,
  storageQuotaBytes,
} from "../lib/quota";

const MB = 1024 * 1024;

describe("checkQuota", () => {
  it("allows a file that fits in the remaining space", () => {
    const result = checkQuota({ usedBytes: 10 * MB, incomingBytes: 5 * MB, quotaBytes: 20 * MB });
    assert.equal(result.ok, true);
    assert.equal(result.remainingBytes, 10 * MB);
  });

  it("allows a file that lands exactly on the quota", () => {
    const result = checkQuota({ usedBytes: 15 * MB, incomingBytes: 5 * MB, quotaBytes: 20 * MB });
    assert.equal(result.ok, true);
  });

  it("rejects the byte that would cross the quota", () => {
    const result = checkQuota({ usedBytes: 15 * MB, incomingBytes: 5 * MB + 1, quotaBytes: 20 * MB });
    assert.equal(result.ok, false);
  });

  it("rejects with 507, not 413", () => {
    // 413 would say "send a smaller file", which is wrong: no file will fit
    // until something is deleted.
    const result = checkQuota({ usedBytes: 20 * MB, incomingBytes: 1, quotaBytes: 20 * MB });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 507);
  });

  it("says how much is left and what to do about it", () => {
    const result = checkQuota({ usedBytes: 18 * MB, incomingBytes: 5 * MB, quotaBytes: 20 * MB });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /Storage quota exceeded/);
    assert.match(result.error, /2\.0 MB left/);
    assert.match(result.error, /20\.0 MB/);
    assert.match(result.error, /Delete an image/);
    assert.equal(result.remainingBytes, 2 * MB);
  });

  it("never reports negative remaining space when usage is already over", () => {
    const result = checkQuota({ usedBytes: 30 * MB, incomingBytes: 1, quotaBytes: 20 * MB });
    assert.equal(result.remainingBytes, 0);
  });

  it("rejects any file for a user with a zero-byte allowance left", () => {
    const result = checkQuota({ usedBytes: 20 * MB, incomingBytes: 1, quotaBytes: 20 * MB });
    assert.equal(result.ok, false);
  });
});

describe("storageQuotaBytes", () => {
  it("falls back to the default when unset", () => {
    assert.equal(storageQuotaBytes({}), DEFAULT_STORAGE_QUOTA_BYTES);
  });

  it("reads an override from the environment", () => {
    assert.equal(storageQuotaBytes({ IMAGE_STORAGE_QUOTA_BYTES: "512" }), 512);
  });

  for (const bad of ["", "nonsense", "-1", "0"]) {
    it(`ignores the unusable value ${JSON.stringify(bad)}`, () => {
      // A misconfigured value must not silently mean "no storage allowed" or
      // "unlimited"; both are worse than the documented default.
      assert.equal(
        storageQuotaBytes({ IMAGE_STORAGE_QUOTA_BYTES: bad }),
        DEFAULT_STORAGE_QUOTA_BYTES
      );
    });
  }
});
