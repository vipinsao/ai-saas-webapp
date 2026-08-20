/**
 * Upload rules shared by the API routes and the tests.
 *
 * Everything here is pure so the rejection paths can be asserted directly
 * instead of being exercised through an HTTP round trip.
 */

export const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
] as const;

export const VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
] as const;

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MB

export interface UploadCandidate {
  type: string;
  size: number;
}

export interface UploadRules {
  allowedMimeTypes: readonly string[];
  maxBytes: number;
}

export type UploadValidation =
  | { ok: true }
  | { ok: false; status: number; error: string };

export const IMAGE_UPLOAD_RULES: UploadRules = {
  allowedMimeTypes: IMAGE_MIME_TYPES,
  maxBytes: MAX_IMAGE_BYTES,
};

export const VIDEO_UPLOAD_RULES: UploadRules = {
  allowedMimeTypes: VIDEO_MIME_TYPES,
  maxBytes: MAX_VIDEO_BYTES,
};

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return Number.isInteger(mb) ? `${mb}MB` : `${mb.toFixed(1)}MB`;
}

/**
 * A browser can send any Content-Type it likes, so this is a first filter and
 * not a security boundary. The image pipeline re-checks the real format by
 * decoding the bytes with sharp; a file that only claims to be a PNG fails
 * there.
 */
export function validateUpload(
  file: UploadCandidate | null,
  rules: UploadRules
): UploadValidation {
  if (!file) {
    return { ok: false, status: 400, error: "No file was included in the request" };
  }

  if (!rules.allowedMimeTypes.includes(file.type)) {
    return {
      ok: false,
      status: 415,
      error: `Unsupported file type "${file.type || "unknown"}". Allowed: ${rules.allowedMimeTypes.join(", ")}`,
    };
  }

  if (file.size <= 0) {
    return { ok: false, status: 400, error: "File is empty" };
  }

  if (file.size > rules.maxBytes) {
    return {
      ok: false,
      status: 413,
      error: `File is too large (${formatBytes(file.size)}). Maximum is ${formatBytes(rules.maxBytes)}`,
    };
  }

  return { ok: true };
}
