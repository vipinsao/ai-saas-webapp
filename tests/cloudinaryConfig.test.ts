import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeCloudinaryFailure, resolveCloudinaryConfig } from "../lib/cloudinary";

const COMPLETE = {
  NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME: "demo-cloud",
  CLOUDINARY_API_KEY: "123456789",
  CLOUDINARY_API_SECRET: "s3cr3t",
};

describe("resolveCloudinaryConfig", () => {
  it("accepts a complete configuration", () => {
    const result = resolveCloudinaryConfig(COMPLETE);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.config, {
      cloudName: "demo-cloud",
      apiKey: "123456789",
      apiSecret: "s3cr3t",
    });
  });

  it("trims surrounding whitespace, which a copy-paste from a dashboard adds", () => {
    const result = resolveCloudinaryConfig({ ...COMPLETE, CLOUDINARY_API_KEY: "  123  " });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.apiKey, "123");
  });

  it("names every missing variable rather than failing generically", () => {
    const result = resolveCloudinaryConfig({});
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.missing, [
      "NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME",
      "CLOUDINARY_API_KEY",
      "CLOUDINARY_API_SECRET",
    ]);
    assert.match(result.error, /NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME/);
    assert.match(result.error, /\.env/);
  });

  it("treats a present-but-empty variable as missing", () => {
    // .env.example ships these as empty strings, so this is the common case.
    const result = resolveCloudinaryConfig({ ...COMPLETE, CLOUDINARY_API_SECRET: "   " });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.missing, ["CLOUDINARY_API_SECRET"]);
  });

  it("does not accept a misspelled variable name", () => {
    // The bug this whole module exists for: `Next_PUBLIC_...` used to leave the
    // client configured with `undefined` and fail much later, generically.
    const result = resolveCloudinaryConfig({
      Next_PUBLIC_CLOUDINARY_CLOUD_NAME: "demo-cloud",
      CLOUDINARY_API_KEY: "123",
      CLOUDINARY_API_SECRET: "s3cr3t",
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.deepEqual(result.missing, ["NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME"]);
  });

  it("answers 503, so a misconfiguration is not mistaken for a crash", () => {
    const result = resolveCloudinaryConfig({});
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 503);
  });

  it("says the image half still works", () => {
    const result = resolveCloudinaryConfig({});
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /image features do not need Cloudinary/);
  });
});

describe("describeCloudinaryFailure", () => {
  it("tells bad credentials apart and names the variables to check", () => {
    const failure = describeCloudinaryFailure({
      message: "Invalid Signature",
      name: "Error",
      http_code: 401,
    });
    assert.equal(failure.status, 502);
    assert.match(failure.error, /rejected the configured credentials \(401\)/);
    assert.match(failure.error, /CLOUDINARY_API_SECRET/);
  });

  it("treats 403 the same way", () => {
    assert.equal(describeCloudinaryFailure({ http_code: 403 }).status, 502);
  });

  it("passes a rate limit through as a 429", () => {
    const failure = describeCloudinaryFailure({ http_code: 420, message: "Rate limit reached" });
    assert.equal(failure.status, 429);
    assert.match(failure.error, /rate limiting/);
  });

  it("passes a rejected file back as a 400 with Cloudinary's own reason", () => {
    const failure = describeCloudinaryFailure({
      http_code: 400,
      message: "Video file is corrupt or has an unsupported format",
    });
    assert.equal(failure.status, 400);
    assert.match(failure.error, /Video file is corrupt/);
  });

  it("recognises a network failure, where the request never arrived", () => {
    const failure = describeCloudinaryFailure(
      Object.assign(new Error("getaddrinfo ENOTFOUND api.cloudinary.com"), { code: "ENOTFOUND" })
    );
    assert.equal(failure.status, 502);
    assert.match(failure.error, /Could not reach Cloudinary \(ENOTFOUND\)/);
  });

  it("falls back to 502 with whatever message it was given", () => {
    const failure = describeCloudinaryFailure(new Error("something odd"));
    assert.equal(failure.status, 502);
    assert.match(failure.error, /something odd/);
  });

  it("does not throw on a null or shapeless rejection", () => {
    // The SDK rejects with a plain object, not an Error, so nothing about the
    // shape can be assumed.
    assert.equal(describeCloudinaryFailure(null).status, 502);
    assert.equal(describeCloudinaryFailure("a string").status, 502);
    assert.match(describeCloudinaryFailure(undefined).error, /unknown error/);
  });
});
