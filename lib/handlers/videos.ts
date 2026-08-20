import { NextRequest, NextResponse } from "next/server";
import {
  createCloudinaryClient,
  describeCloudinaryFailure,
  resolveCloudinaryConfig,
  type CloudinaryClient,
} from "../cloudinary";
import type { EnvLike } from "../env";
import type { VideoIndex } from "../mediaIndex";
import { tooManyRequests, uploadRateLimiter } from "../rateLimiters";
import { VIDEO_UPLOAD_RULES, validateUpload } from "../uploadValidation";
import type { AuthPort, RateLimiterPort, RouteContext } from "./deps";

/** Folder every upload lands in, so the account stays tidy and is easy to audit. */
export const VIDEO_FOLDER = "video-uploads";

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2000;

export type CloudinaryProviderResult =
  | { ok: true; client: CloudinaryClient }
  | { ok: false; status: number; error: string; missing?: string[] };

/**
 * Resolves a usable client, or explains in one sentence why there isn't one.
 *
 * Returning the failure instead of throwing is the whole point: a missing
 * variable is a configuration answer with a status code, not an exception that
 * falls into a catch-all and comes back as "Error uploading video".
 */
export type CloudinaryProvider = () => CloudinaryProviderResult;

export function envCloudinaryProvider(env: EnvLike = process.env): CloudinaryProviderResult {
  const resolved = resolveCloudinaryConfig(env);
  if (!resolved.ok) {
    return { ok: false, status: resolved.status, error: resolved.error, missing: resolved.missing };
  }
  return { ok: true, client: createCloudinaryClient(resolved.config) };
}

export interface VideoHandlerDeps {
  auth: AuthPort;
  index: VideoIndex;
  cloudinary: CloudinaryProvider;
  limiter?: RateLimiterPort;
}

function readText(formData: FormData, field: string): string {
  const value = formData.get(field);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * POST /api/video-upload
 *
 * Remote asset first, row second -- the opposite of the image upload, and for
 * the same reason the deletes are opposite too. See the delete handler below.
 */
export function createVideoUploadHandler(deps: VideoHandlerDeps) {
  const { auth, index, cloudinary, limiter = uploadRateLimiter } = deps;

  return async function POST(request: NextRequest): Promise<NextResponse> {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Checked before the body is read: there is no point streaming 200 MB into
    // memory to discover the server has no credentials to send it with.
    const provider = cloudinary();
    if (!provider.ok) {
      return NextResponse.json(
        { error: provider.error, missing: provider.missing },
        { status: provider.status }
      );
    }

    const limit = limiter.check(userId);
    if (!limit.allowed) return tooManyRequests(limit.retryAfterSeconds);

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return NextResponse.json({ error: "Malformed upload" }, { status: 400 });
    }

    const file = formData.get("file") as File | null;
    // The page checks the size too, but a client-side check is a courtesy, not
    // a control: the endpoint is reachable with curl.
    const validation = validateUpload(file, VIDEO_UPLOAD_RULES);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: validation.status });
    }

    const title = readText(formData, "title");
    const description = readText(formData, "description");
    // `title` is NOT NULL in the schema. A request without it used to reach
    // Prisma with `null` and come back as a 500.
    if (!title) {
      return NextResponse.json({ error: "A title is required" }, { status: 400 });
    }
    if (title.length > MAX_TITLE_LENGTH) {
      return NextResponse.json(
        { error: `Title is too long (maximum ${MAX_TITLE_LENGTH} characters)` },
        { status: 400 }
      );
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return NextResponse.json(
        { error: `Description is too long (maximum ${MAX_DESCRIPTION_LENGTH} characters)` },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file!.arrayBuffer());

    let uploaded;
    try {
      uploaded = await provider.client.uploadVideo(buffer, { folder: VIDEO_FOLDER });
    } catch (error) {
      console.error("Cloudinary video upload failed", error);
      const failure = describeCloudinaryFailure(error);
      return NextResponse.json({ error: failure.error }, { status: failure.status });
    }

    try {
      const video = await index.create({
        userId,
        title,
        description: description || null,
        publicId: uploaded.public_id,
        // Both sizes are measured server-side. The original used to come from a
        // form field, so the compression figure was whatever the client claimed.
        originalSize: String(buffer.length),
        compressedSize: String(uploaded.bytes),
        duration: uploaded.duration ?? 0,
      });
      return NextResponse.json(video);
    } catch (error) {
      // The row is the only handle on the remote asset, so failing to write it
      // strands a file in Cloudinary that nothing can ever name again. Undo the
      // upload rather than leak it.
      console.error("Video index write failed; removing the uploaded asset", error);
      await provider.client.destroyVideo(uploaded.public_id).catch(() => undefined);
      return NextResponse.json({ error: "Could not record the upload" }, { status: 500 });
    }
  };
}

/**
 * DELETE /api/videos/:id
 *
 * Remote asset first, row second -- deliberately the reverse of the image
 * delete, because the recoverable half-state is the reverse too.
 *
 * A local image that loses its row is still findable: the reaper walks the
 * storage directory and picks it up. A Cloudinary asset that loses its row is
 * not. `publicId` is the only handle this app has on it, it exists in exactly
 * one place, and once the row is gone nothing in the app can name the asset to
 * delete it. So the row is deleted last, and if the remote delete fails the row
 * stays put and the user can retry.
 *
 * The cost of this order is the mirror-image residue: a crash between the two
 * leaves a row pointing at an asset that no longer exists. That is visible (a
 * broken thumbnail) and self-healing -- pressing delete again re-runs destroy,
 * which answers `{ result: "not found" }` for an asset that has already gone,
 * and the row is then removed.
 */
export function createVideoDeleteHandler(deps: VideoHandlerDeps) {
  const { auth, index, cloudinary } = deps;

  return async function DELETE(
    _request: NextRequest,
    { params }: RouteContext<{ id: string }>
  ): Promise<NextResponse> {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Video id is required" }, { status: 400 });
    }

    // Owner-scoped read. Someone else's id is reported as "not found" rather
    // than "forbidden", which would confirm that the id exists.
    const video = await index.findOwned(userId, id);
    if (!video) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }

    const provider = cloudinary();
    if (!provider.ok) {
      // Deleting the row anyway would silently orphan the remote asset, so the
      // delete refuses instead. The row is still there to try again with.
      return NextResponse.json(
        { error: provider.error, missing: provider.missing },
        { status: provider.status }
      );
    }

    let remoteResult: string;
    try {
      remoteResult = (await provider.client.destroyVideo(video.publicId)).result;
    } catch (error) {
      console.error("Cloudinary destroy failed", error);
      const failure = describeCloudinaryFailure(error);
      return NextResponse.json(
        { error: `The video was not deleted. ${failure.error}` },
        { status: failure.status }
      );
    }

    const removed = await index.deleteOwned(userId, id);

    return NextResponse.json({
      id,
      // `removed === 0` means a concurrent request deleted the row between the
      // read and the write. The asset is gone either way, so this is still a
      // success; it is reported so the state is not silently glossed over.
      deleted: true,
      rowsRemoved: removed,
      remoteResult,
    });
  };
}
