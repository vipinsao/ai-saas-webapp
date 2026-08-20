import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { SNIFF_BYTES, sniffImageFormat } from "../lib/imageSniff";

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "landscape.png");

function bytes(...values: (number | string)[]): Buffer {
  return Buffer.concat(
    values.map((v) => (typeof v === "string" ? Buffer.from(v, "latin1") : Buffer.from([v])))
  );
}

describe("sniffImageFormat: formats the pipeline can safely decode", () => {
  it("identifies the committed PNG fixture", async () => {
    assert.equal(sniffImageFormat(await readFile(FIXTURE)), "image/png");
  });

  it("identifies a PNG by its 8-byte signature", () => {
    assert.equal(sniffImageFormat(bytes(0x89, "PNG\r\n", 0x1a, 0x0a, 0, 0)), "image/png");
  });

  it("identifies a JPEG", () => {
    assert.equal(sniffImageFormat(bytes(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  });

  it("identifies both GIF versions", () => {
    assert.equal(sniffImageFormat(bytes("GIF87a....")), "image/gif");
    assert.equal(sniffImageFormat(bytes("GIF89a....")), "image/gif");
  });

  it("identifies WebP, whose marker sits after a four-byte length", () => {
    assert.equal(sniffImageFormat(bytes("RIFF", "\x00\x01\x00\x00", "WEBPVP8 ")), "image/webp");
  });

  it("identifies AVIF by its ftyp brand", () => {
    assert.equal(sniffImageFormat(bytes("\x00\x00\x00\x20", "ftyp", "avif", "0000")), "image/avif");
    assert.equal(sniffImageFormat(bytes("\x00\x00\x00\x20", "ftyp", "avis", "0000")), "image/avif");
  });
});

describe("sniffImageFormat: everything else is refused", () => {
  it("refuses SVG, which is the decode bomb", () => {
    // The exact payload: 119 bytes that cost 4967 ms of CPU once sharp had it.
    const bomb = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="8000"><rect width="100%" height="100%" fill="#f00"/></svg>'
    );
    assert.equal(sniffImageFormat(bomb), null);
  });

  it("refuses SVG however it is dressed up", () => {
    for (const variant of [
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>',
      "﻿<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
      "   \n\t<svg/>",
      "<!DOCTYPE svg><svg/>",
    ]) {
      assert.equal(sniffImageFormat(Buffer.from(variant)), null, variant.slice(0, 24));
    }
  });

  it("refuses other things that arrive claiming to be images", () => {
    assert.equal(sniffImageFormat(bytes("%PDF-1.7")), null);
    assert.equal(sniffImageFormat(bytes("PK", 0x03, 0x04)), null, "zip");
    assert.equal(sniffImageFormat(bytes("<!DOCTYPE html>")), null);
    assert.equal(sniffImageFormat(bytes(0x7f, "ELF")), null);
    assert.equal(sniffImageFormat(bytes("MZ")), null, "windows executable");
    assert.equal(sniffImageFormat(bytes("BM", 0, 0, 0, 0)), null, "bmp is not in the allowlist");
  });

  it("refuses a non-AVIF ISO container", () => {
    // mp4 shares the ftyp box, so the brand has to be checked, not just "ftyp".
    assert.equal(sniffImageFormat(bytes("\x00\x00\x00\x20", "ftyp", "isom", "0000")), null);
    assert.equal(sniffImageFormat(bytes("\x00\x00\x00\x20", "ftyp", "mp42", "0000")), null);
  });

  it("refuses empty and truncated input without throwing", () => {
    assert.equal(sniffImageFormat(Buffer.alloc(0)), null);
    for (let length = 1; length < SNIFF_BYTES; length += 1) {
      assert.doesNotThrow(() => sniffImageFormat(Buffer.alloc(length)));
    }
    // A truncated PNG signature is not a PNG.
    assert.equal(sniffImageFormat(bytes(0x89, "PNG")), null);
  });

  it("refuses a real image's bytes with one byte of the signature flipped", () => {
    const png = bytes(0x89, "PNG\r\n", 0x1a, 0x0a, 0, 0);
    png[3] = 0x00;
    assert.equal(sniffImageFormat(png), null);
  });
});
