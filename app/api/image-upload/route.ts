import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { normaliseUpload } from "@/lib/imagePipeline";
import { newImageId, saveImage } from "@/lib/imageStore";
import { tooManyRequests, uploadRateLimiter } from "@/lib/rateLimiters";
import { IMAGE_UPLOAD_RULES, validateUpload } from "@/lib/uploadValidation";

// sharp is a native module, so this handler must not run on the edge runtime.
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = uploadRateLimiter.check(userId);
  if (!limit.allowed) {
    return tooManyRequests(limit.retryAfterSeconds);
  }

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

  try {
    const buffer = Buffer.from(await file!.arrayBuffer());
    // Decoding here is what turns a declared Content-Type into a verified one:
    // bytes that are not a real image throw before anything is written to disk.
    const normalised = await normaliseUpload(buffer);
    const id = newImageId();
    await saveImage(userId, id, normalised.buffer);

    return NextResponse.json({
      id,
      width: normalised.width,
      height: normalised.height,
      bytes: normalised.bytes,
      originalBytes: buffer.length,
    });
  } catch (error) {
    console.error("Image upload failed", error);
    return NextResponse.json(
      { error: "That file could not be read as an image" },
      { status: 400 }
    );
  }
}
