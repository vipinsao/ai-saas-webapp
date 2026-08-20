import sharp from "sharp";
import { SOCIAL_FORMATS, type SocialFormatId } from "./socialFormats";

export * from "./socialFormats";

/**
 * Local image processing. Every transform below runs in this process through
 * libvips (via sharp) — no media API, no account, no network call.
 */

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
 */
export async function normaliseUpload(input: Buffer): Promise<ProcessedImage> {
  const pipeline = sharp(input, { failOn: "error" }).rotate().webp({ quality: 82 });
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
  const { data, info } = await sharp(input, { failOn: "error" })
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
