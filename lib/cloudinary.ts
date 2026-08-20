import { v2 as cloudinary } from "cloudinary";
import type { EnvLike } from "./env";

/**
 * Everything the app knows about Cloudinary, in one module with no Next.js and
 * no Prisma in it.
 *
 * Two reasons it is separate from the route:
 *
 * 1. Configuration used to be applied at module load from `process.env`, so a
 *    typo in a variable name (there was one: `Next_PUBLIC_CLOUDINARY_CLOUD_NAME`)
 *    produced a client configured with `undefined` and a generic 500 at request
 *    time. Resolving the config explicitly turns that into a named error.
 * 2. `CloudinaryClient` is a two-method interface, so the upload and delete
 *    handlers can be driven end to end against a fake in tests. See
 *    tests/videoHandlers.test.ts, and the honest note in DECISIONS.md about
 *    what that does and does not prove.
 */

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/** Names as they appear in .env.example, so the error message is copy-pasteable. */
const REQUIRED_VARS = [
  "NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
] as const;

export type CloudinaryConfigResult =
  | { ok: true; config: CloudinaryConfig }
  | { ok: false; missing: string[]; status: 503; error: string };

/**
 * A variable that is absent and a variable that is present-but-empty are the
 * same failure, and both are reported by name. `.env.example` ships the
 * Cloudinary entries as empty strings, so "set but blank" is the common case.
 */
export function resolveCloudinaryConfig(env: EnvLike = process.env): CloudinaryConfigResult {
  const missing = REQUIRED_VARS.filter((name) => !env[name]?.trim());

  if (missing.length > 0) {
    return {
      ok: false,
      missing: [...missing],
      // 503 rather than 500: nothing threw, the server is answering correctly
      // that a dependency it needs has not been configured. A 500 would send an
      // operator looking for a bug in the handler.
      status: 503,
      error:
        `Video upload is not configured: ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} missing. ` +
        `Set ${missing.length === 1 ? "it" : "them"} in .env.local (see .env.example). ` +
        `The image features do not need Cloudinary and keep working without it.`,
    };
  }

  return {
    ok: true,
    config: {
      cloudName: env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME!.trim(),
      apiKey: env.CLOUDINARY_API_KEY!.trim(),
      apiSecret: env.CLOUDINARY_API_SECRET!.trim(),
    },
  };
}

export interface CloudinaryUploadResult {
  public_id: string;
  bytes: number;
  duration?: number;
}

export interface CloudinaryDestroyResult {
  /** "ok" when the asset was removed, "not found" when it was already gone. */
  result: string;
}

export interface CloudinaryClient {
  uploadVideo(buffer: Buffer, options: { folder: string }): Promise<CloudinaryUploadResult>;
  destroyVideo(publicId: string): Promise<CloudinaryDestroyResult>;
}

/**
 * Wraps the SDK. The SDK's config is global module state, so it is applied on
 * every call from a config that has already been validated, rather than once at
 * import time from whatever `process.env` happened to hold.
 */
export function createCloudinaryClient(config: CloudinaryConfig): CloudinaryClient {
  function configure() {
    cloudinary.config({
      cloud_name: config.cloudName,
      api_key: config.apiKey,
      api_secret: config.apiSecret,
    });
  }

  return {
    uploadVideo(buffer, options) {
      configure();
      return new Promise<CloudinaryUploadResult>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: "video",
            folder: options.folder,
            transformation: [{ quality: "auto", fetch_format: "mp4" }],
          },
          (error, result) => {
            if (error) reject(error);
            else if (!result) reject(new Error("Cloudinary returned no result"));
            else resolve(result as unknown as CloudinaryUploadResult);
          }
        );
        stream.end(buffer);
      });
    },

    async destroyVideo(publicId) {
      configure();
      // resource_type must be "video": destroy defaults to "image" and would
      // report "not found" for a video that is very much still there.
      const result = await cloudinary.uploader.destroy(publicId, { resource_type: "video" });
      return result as CloudinaryDestroyResult;
    },
  };
}

export interface CloudinaryFailure {
  status: number;
  error: string;
}

interface MaybeCloudinaryError {
  message?: unknown;
  http_code?: unknown;
  name?: unknown;
  code?: unknown;
}

/**
 * Turns whatever the SDK rejected with into a status and a sentence.
 *
 * The SDK's own type for this is `UploadApiErrorResponse { message, name,
 * http_code }` -- a plain object, not necessarily an Error -- so `instanceof
 * Error` is not a safe test and the fields are read defensively.
 *
 * The point is that the four things that actually go wrong are told apart:
 * wrong keys, a rejected file, a throttle, and no network. Before this they
 * were one 500 reading "Error uploading video".
 */
export function describeCloudinaryFailure(error: unknown): CloudinaryFailure {
  const candidate = (error ?? {}) as MaybeCloudinaryError;
  const message = typeof candidate.message === "string" ? candidate.message : "";
  const httpCode = typeof candidate.http_code === "number" ? candidate.http_code : undefined;
  const code = typeof candidate.code === "string" ? candidate.code : undefined;

  // No DNS / no route / refused: the request never reached Cloudinary.
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED" || code === "ETIMEDOUT") {
    return {
      status: 502,
      error: `Could not reach Cloudinary (${code}). Check the machine's network connection.`,
    };
  }

  if (httpCode === 401 || httpCode === 403) {
    return {
      status: 502,
      error:
        `Cloudinary rejected the configured credentials (${httpCode}). ` +
        `Check CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET, and that they belong ` +
        `to the cloud named in NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME.`,
    };
  }

  if (httpCode === 420 || httpCode === 429) {
    return {
      status: 429,
      error: `Cloudinary is rate limiting this account (${httpCode}). Try again later.`,
    };
  }

  if (httpCode === 400) {
    // Cloudinary's own message is the useful part here ("Video file is corrupt",
    // "File size too large for the free plan", ...), so it is passed through.
    return {
      status: 400,
      error: `Cloudinary rejected the file: ${message || "no reason given"}`,
    };
  }

  return {
    status: 502,
    error: `Cloudinary upload failed${httpCode ? ` (${httpCode})` : ""}: ${message || "unknown error"}`,
  };
}
