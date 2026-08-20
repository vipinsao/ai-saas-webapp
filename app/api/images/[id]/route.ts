import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  OUTPUT_EXTENSION,
  isSocialFormatId,
  SOCIAL_FORMAT_IDS,
  transformToSocialFormat,
} from "@/lib/imagePipeline";
import { isValidImageId, readImage } from "@/lib/imageStore";
import { tooManyRequests, transformRateLimiter } from "@/lib/rateLimiters";

export const runtime = "nodejs";

/**
 * GET /api/images/:id?format=instagram-square[&download=1]
 *
 * Reads the caller's own stored upload and crops it to a preset on demand.
 * Nothing is precomputed, so adding a preset needs no migration or backfill.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = transformRateLimiter.check(userId);
  if (!limit.allowed) {
    return tooManyRequests(limit.retryAfterSeconds);
  }

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

  // readImage builds the path from the caller's own user id, so another user's
  // id is unreachable even if it is guessed.
  const stored = await readImage(userId, id);
  if (!stored) {
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
}
