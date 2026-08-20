import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import {
  SOCIAL_FORMATS,
  SOCIAL_FORMAT_IDS,
  isSocialFormatId,
  normaliseUpload,
  transformToSocialFormat,
} from "../lib/imagePipeline";

// Resolved from the repo root: the test script is always run from there.
const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "landscape.png");

async function fixture(): Promise<Buffer> {
  return readFile(FIXTURE);
}

describe("format table", () => {
  it("exposes every id declared in the table", () => {
    assert.equal(SOCIAL_FORMAT_IDS.length, Object.keys(SOCIAL_FORMATS).length);
    assert.ok(isSocialFormatId("instagram-square"));
  });

  it("rejects unknown ids, including inherited object properties", () => {
    assert.equal(isSocialFormatId("nope"), false);
    // Object.prototype.hasOwnProperty, not the `in` operator: "toString" would
    // otherwise pass and index into undefined.
    assert.equal(isSocialFormatId("toString"), false);
  });
});

describe("normaliseUpload", () => {
  it("re-encodes to WebP and keeps the pixel dimensions", async () => {
    const result = await normaliseUpload(await fixture());
    assert.equal(result.contentType, "image/webp");
    assert.equal(result.width, 1600);
    assert.equal(result.height, 900);
    const meta = await sharp(result.buffer).metadata();
    assert.equal(meta.format, "webp");
  });

  it("applies EXIF orientation instead of leaving the image sideways", async () => {
    // Orientation 6 means "rotate 90° clockwise on display". After .rotate()
    // the stored pixels are upright, so width and height swap.
    const rotated = await sharp(await fixture())
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const result = await normaliseUpload(rotated);
    assert.equal(result.width, 900);
    assert.equal(result.height, 1600);
  });

  it("drops EXIF metadata from the stored copy", async () => {
    const withExif = await sharp(await fixture())
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    assert.notEqual((await sharp(withExif).metadata()).exif, undefined);

    const result = await normaliseUpload(withExif);
    assert.equal((await sharp(result.buffer).metadata()).exif, undefined);
  });

  it("rejects bytes that are not a decodable image", async () => {
    await assert.rejects(() => normaliseUpload(Buffer.from("MZ this is an executable")));
  });

  it("rejects an empty buffer", async () => {
    await assert.rejects(() => normaliseUpload(Buffer.alloc(0)));
  });
});

describe("transformToSocialFormat", () => {
  for (const id of SOCIAL_FORMAT_IDS) {
    it(`produces exactly ${SOCIAL_FORMATS[id].width}x${SOCIAL_FORMATS[id].height} for ${id}`, async () => {
      const result = await transformToSocialFormat(await fixture(), id);
      assert.equal(result.width, SOCIAL_FORMATS[id].width);
      assert.equal(result.height, SOCIAL_FORMATS[id].height);
      assert.equal(result.contentType, "image/webp");
      assert.ok(result.bytes > 0);
      const meta = await sharp(result.buffer).metadata();
      assert.equal(meta.width, SOCIAL_FORMATS[id].width);
      assert.equal(meta.height, SOCIAL_FORMATS[id].height);
    });
  }

  it("upscales a source smaller than the target rather than returning it unchanged", async () => {
    const small = await sharp(await fixture()).resize({ width: 200 }).png().toBuffer();
    const result = await transformToSocialFormat(small, "twitter-header");
    assert.equal(result.width, SOCIAL_FORMATS["twitter-header"].width);
    assert.equal(result.height, SOCIAL_FORMATS["twitter-header"].height);
  });

  it("keeps the high-detail subject when cropping to a square", async () => {
    // The fixture puts a saturated checkerboard block on the right-hand side of
    // an otherwise flat background. position: "attention" should crop towards
    // it, so the square output is not the uniform left half.
    const result = await transformToSocialFormat(await fixture(), "instagram-square");
    const stats = await sharp(result.buffer).stats();
    const maxChannelDeviation = Math.max(...stats.channels.map((c) => c.stdev));
    assert.ok(
      maxChannelDeviation > 20,
      `expected a detailed crop, got stdev ${maxChannelDeviation}`
    );
  });

  it("rejects bytes that are not a decodable image", async () => {
    await assert.rejects(() => transformToSocialFormat(Buffer.from("nope"), "twitter-post"));
  });
});
