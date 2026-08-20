import { NextRequest, NextResponse } from "next/server";
import {
  OUTPUT_EXTENSION,
  isSocialFormatId,
  normaliseUpload,
  SOCIAL_FORMAT_IDS,
  transformToSocialFormat,
} from "../imagePipeline";
import {
  defaultStorageRoot,
  deleteImage,
  isValidImageId,
  newImageId,
  readImage,
  saveImage,
} from "../imageStore";
import type { ImageIndex, ImageRecord } from "../mediaIndex";
import { checkQuota, storageQuotaBytes } from "../quota";
import { tooManyRequests, uploadRateLimiter, transformRateLimiter } from "../rateLimiters";
import { IMAGE_UPLOAD_RULES, validateUpload } from "../uploadValidation";
import type { AuthPort, RateLimiterPort, RouteContext } from "./deps";

export interface ImageHandlerDeps {
  auth: AuthPort;
  index: ImageIndex;
  /** Overridden in tests so nothing is written outside a temp directory. */
  root?: string;
  /** Overridden in tests so a two-byte file can exceed the quota. */
  quotaBytes?: number;
  limiter?: RateLimiterPort;
}

function publicShape(record: ImageRecord) {
  return {
    id: record.id,
    width: record.width,
    height: record.height,
    bytes: record.bytes,
    originalBytes: record.originalBytes,
    createdAt: record.createdAt,
  };
}

/**
 * POST /api/image-upload
 *
 * Write order is file first, row second. The two orders in this file are the
 * whole crash-consistency argument; lib/reaper.ts states it in full.
 */
export function createImageUploadHandler(deps: ImageHandlerDeps) {
  const { auth, index, root = defaultStorageRoot(), limiter = uploadRateLimiter } = deps;

  return async function POST(request: NextRequest): Promise<NextResponse> {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const limit = limiter.check(userId);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

    let file: File | null;
    try {
      const formData = await request.formData();
      file = formData.get("file") as File | null;
    } catch {
      return NextResponse.json({ error: "Malformed upload" }, { status: 400 });
    }

    const validation = validateUpload(file, IMAGE_UPLOAD_RULES);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: validation.status });
    }

    let normalised;
    let originalBytes: number;
    try {
      const buffer = Buffer.from(await file!.arrayBuffer());
      originalBytes = buffer.length;
      // Decoding is what turns a declared Content-Type into a verified one:
      // bytes that are not a real image throw before anything is written.
      normalised = await normaliseUpload(buffer);
    } catch (error) {
      console.error("Image upload failed", error);
      return NextResponse.json(
        { error: "That file could not be read as an image" },
        { status: 400 }
      );
    }

    // The quota is checked against the encoded size, not the uploaded size,
    // because the encoded size is what actually lands on disk. Checking the
    // uploaded size first would be cheaper but would reject files that would
    // have fitted -- WebP is usually a good deal smaller than the original.
    const quota = checkQuota({
      usedBytes: await index.usedBytes(userId),
      incomingBytes: normalised.bytes,
      quotaBytes: deps.quotaBytes ?? storageQuotaBytes(),
    });
    if (!quota.ok) {
      return NextResponse.json(
        {
          error: quota.error,
          usedBytes: quota.usedBytes,
          quotaBytes: quota.quotaBytes,
          remainingBytes: quota.remainingBytes,
        },
        { status: quota.status }
      );
    }

    const id = newImageId();
    await saveImage(userId, id, normalised.buffer, root);

    let record: ImageRecord;
    try {
      record = await index.create({
        id,
        userId,
        bytes: normalised.bytes,
        originalBytes,
        width: normalised.width,
        height: normalised.height,
      });
    } catch (error) {
      // The row is what makes the file reachable, so a file with no row is
      // dead weight. Undo it here rather than waiting for the reaper; if this
      // unlink also fails the reaper is still the backstop.
      await deleteImage(userId, id, root).catch(() => undefined);
      console.error("Image index write failed", error);
      return NextResponse.json({ error: "Could not record the upload" }, { status: 500 });
    }

    return NextResponse.json(publicShape(record));
  };
}

/** GET /api/images -- the caller's images plus their quota position. */
export function createImageListHandler(deps: ImageHandlerDeps) {
  const { auth, index } = deps;

  return async function GET(): Promise<NextResponse> {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [images, usedBytes] = await Promise.all([
      index.listOwned(userId),
      index.usedBytes(userId),
    ]);
    const quotaBytes = deps.quotaBytes ?? storageQuotaBytes();

    return NextResponse.json({
      images: images.map(publicShape),
      usage: {
        usedBytes,
        quotaBytes,
        remainingBytes: Math.max(0, quotaBytes - usedBytes),
      },
    });
  };
}

/**
 * GET /api/images/:id?format=...
 *
 * The row is consulted before the file. That is not belt-and-braces: it is what
 * makes a delete take effect immediately. Deleting removes the row first, so
 * between the two statements the file is still on disk -- serving it from disk
 * alone would keep handing out content the user has already deleted.
 */
export function createImageTransformHandler(deps: ImageHandlerDeps) {
  const { auth, index, root = defaultStorageRoot(), limiter = transformRateLimiter } = deps;

  return async function GET(
    request: NextRequest,
    { params }: RouteContext<{ id: string }>
  ): Promise<NextResponse> {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const limit = limiter.check(userId);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

    const { id } = await params;
    if (!isValidImageId(id)) {
      return NextResponse.json({ error: "Invalid image id" }, { status: 400 });
    }

    const format = request.nextUrl.searchParams.get("format") ?? "";
    if (!isSocialFormatId(format)) {
      return NextResponse.json(
        { error: `Unknown format. Expected one of: ${SOCIAL_FORMAT_IDS.join(", ")}` },
        { status: 400 }
      );
    }

    if (!(await index.findOwned(userId, id))) {
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }

    // readImage builds the path from the caller's own user id, so another
    // user's file is not addressable even if the id is known.
    const stored = await readImage(userId, id, root);
    if (!stored) {
      // Indexed but not on disk: an orphan row, which the reaper collects.
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }

    try {
      const output = await transformToSocialFormat(stored, format);
      const headers = new Headers({
        "Content-Type": output.contentType,
        "Content-Length": String(output.bytes),
        // Private: the response is scoped to one signed-in user.
        "Cache-Control": "private, max-age=3600",
      });
      if (request.nextUrl.searchParams.get("download") === "1") {
        headers.set(
          "Content-Disposition",
          `attachment; filename="${format}-${id}.${OUTPUT_EXTENSION}"`
        );
      }
      return new NextResponse(new Uint8Array(output.buffer), { status: 200, headers });
    } catch (error) {
      console.error("Image transform failed", error);
      return NextResponse.json({ error: "Image transform failed" }, { status: 500 });
    }
  };
}

/**
 * DELETE /api/images/:id
 *
 * Row first, file second.
 *
 * Deleting the file first would leave, on a crash in between, a row whose file
 * is gone: the image still lists, still counts against the quota, and 404s when
 * opened. Deleting the row first leaves a file nothing points at -- invisible
 * to every owner-scoped query, and findable again by walking the directory,
 * which is exactly what lib/reaper.ts does. Of the two possible half-states
 * only one is recoverable without user-visible damage, so the delete is ordered
 * to produce that one.
 */
export function createImageDeleteHandler(deps: ImageHandlerDeps) {
  const { auth, index, root = defaultStorageRoot() } = deps;

  return async function DELETE(
    _request: NextRequest,
    { params }: RouteContext<{ id: string }>
  ): Promise<NextResponse> {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    // Checked before anything touches the filesystem. A delete endpoint is a
    // worse traversal target than a read: a read leaks a file, a delete
    // destroys one. `../../.env` is rejected here and again inside
    // resolveImagePath, which throws rather than resolving outside the root.
    if (!isValidImageId(id)) {
      return NextResponse.json({ error: "Invalid image id" }, { status: 400 });
    }

    // Ownership filter and delete in one statement. A row belonging to somebody
    // else comes back as 0 and is reported as 404 -- 403 would confirm the id
    // exists, which is a small oracle worth not handing out.
    const removed = await index.deleteOwned(userId, id);
    if (removed === 0) {
      return NextResponse.json({ error: "Image not found" }, { status: 404 });
    }

    const fileRemoved = await deleteImage(userId, id, root);

    return NextResponse.json({ id, deleted: true, fileRemoved });
  };
}
