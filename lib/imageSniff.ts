/**
 * Identifies an image by its bytes, not by what the request claimed.
 *
 * `validateUpload` filters on the browser-supplied `Content-Type`, and the
 * comment there used to say the pipeline "re-checks the real format by decoding
 * the bytes with sharp". Decoding IS the attack. A 119-byte SVG declared as
 * `image/png` passes the type filter and the 10 MB size filter, and sharp then
 * rasterises it:
 *
 *     <svg xmlns="..." width="8000" height="8000"><rect .../></svg>
 *     -> 8000x8000, 4967 ms of CPU, from 119 bytes of request body
 *
 * The size cap bounds the compressed input, which is the wrong axis entirely:
 * the cost is in the decoded pixels. So the format is settled here, before any
 * decoder runs, by matching a signature.
 *
 * This is an allowlist of binary signatures, and that is what makes it work
 * against this class of bug rather than against one instance of it. SVG is
 * text and has no signature, so it cannot be on the list -- and neither can
 * anything else that is really markup, an archive, or a document, whatever
 * header it arrives with.
 */

export const SNIFFABLE_FORMATS = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
] as const;

export type SniffedFormat = (typeof SNIFFABLE_FORMATS)[number];

/** Longest prefix any check below needs. */
export const SNIFF_BYTES = 16;

function startsWith(bytes: Buffer, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

function ascii(bytes: Buffer, start: number, end: number): string {
  if (bytes.length < end) return "";
  return bytes.subarray(start, end).toString("latin1");
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

/**
 * Returns the real format, or null if the bytes are not one this app accepts.
 *
 * The declared Content-Type is deliberately not an input. A browser that sends
 * `image/jpeg` for a PNG is common and harmless; what matters is that the bytes
 * are one of the five formats the pipeline can safely decode.
 */
export function sniffImageFormat(bytes: Buffer): SniffedFormat | null {
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, JPEG)) return "image/jpeg";

  const first6 = ascii(bytes, 0, 6);
  if (first6 === "GIF87a" || first6 === "GIF89a") return "image/gif";

  // RIFF....WEBP -- the four bytes in between are the chunk length.
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";

  // ISO base media: a 4-byte box length, then "ftyp", then the major brand.
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }

  return null;
}
