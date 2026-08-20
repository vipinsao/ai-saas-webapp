import sharp from "sharp";
import { SOCIAL_FORMATS, type SocialFormatId } from "./socialFormats";

export * from "./socialFormats";

/**
 * Local image processing. Every transform below runs in this process through
 * libvips (via sharp) — no media API, no account, no network call.
 *
 * Because it runs in this process, an upload's cost is this server's cost, and
 * the limits below are what stop one request spending all of it. They are not
 * belt-and-braces: without them a 119-byte body buys 5 seconds of CPU (see
 * lib/imageSniff.ts). `MAX_IMAGE_BYTES` does not help, because it bounds the
 * compressed input and the cost lives in the decoded pixels.
 */

/**
 * Ceiling on decoded input pixels. sharp's own default is 268 megapixels,
 * which is far past anything a camera produces and well inside what a
 * hand-written SVG or a crafted PNG can claim. 50 MP still admits a 8688x5792
 * full-frame raw conversion.
 */
export const MAX_INPUT_PIXELS = 50_000_000;

/**
 * Wall-clock ceiling on the libvips pipeline. The pixel limit bounds the
 * obvious bomb; this bounds whatever the next one turns out to be.
 */
export const DECODE_TIMEOUT_SECONDS = 10;

/**
 * Longest edge of a stored image. Every preset in socialFormats.ts is at most
 * 1500px, so nothing above this is ever displayed -- storing it only pays to
 * decode it again on every transform.
 */
export const MAX_STORED_DIMENSION = 4096;

export const OUTPUT_CONTENT_TYPE = "image/webp";
export const OUTPUT_EXTENSION = "webp";

export interface ProcessedImage {
  buffer: Buffer;
  contentType: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * Decodes the upload and re-encodes it as WebP without resizing. Two jobs:
 * it proves the bytes really are a decodable image (a .exe renamed to .png
 * fails here), and it strips EXIF — including GPS coordinates — because sharp
 * only carries metadata across when explicitly asked to.
 *
 * .rotate() with no argument applies the EXIF orientation before that metadata
 * is dropped, so portrait phone photos do not come out sideways.
 *
 * The caller must have run sniffImageFormat() first: this function is the last
 * line of defence against a decode bomb, not the first.
 */
export async function normaliseUpload(input: Buffer): Promise<ProcessedImage> {
  const pipeline = sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
    .timeout({ seconds: DECODE_TIMEOUT_SECONDS })
    .rotate()
    // Bounds the stored file as well as the work done here, which in turn
    // bounds every later transform: transformToSocialFormat only ever reads
    // something that already came through this.
    .resize({
      width: MAX_STORED_DIMENSION,
      height: MAX_STORED_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 82 });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    buffer: data,
    contentType: OUTPUT_CONTENT_TYPE,
    width: info.width,
    height: info.height,
    bytes: data.length,
  };
}

/**
 * Crops and scales to one of the social presets.
 *
 * fit: "cover" fills the target box and trims the overflow, so the output is
 * always exactly the requested pixel dimensions. position: "attention" asks
 * libvips to keep the highest-entropy region rather than the centre, which is
 * what stops a subject near an edge from being cropped out.
 */
export async function transformToSocialFormat(
  input: Buffer,
  formatId: SocialFormatId
): Promise<ProcessedImage> {
  const format = SOCIAL_FORMATS[formatId];
  const { data, info } = await sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
    .timeout({ seconds: DECODE_TIMEOUT_SECONDS })
    .rotate()
    .resize({
      width: format.width,
      height: format.height,
      fit: "cover",
      position: "attention",
      withoutEnlargement: false,
    })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });

  return {
    buffer: data,
    contentType: OUTPUT_CONTENT_TYPE,
    width: info.width,
    height: info.height,
    bytes: data.length,
  };
}
