import { NextRequest, NextResponse } from "next/server";
import { v2 as cloudinary } from "cloudinary";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { tooManyRequests, uploadRateLimiter } from "@/lib/rateLimiters";
import { VIDEO_UPLOAD_RULES, validateUpload } from "@/lib/uploadValidation";

// cloud_name is safe in the browser bundle (it is part of every delivery URL);
// the key and secret are server-only and must never gain a NEXT_PUBLIC_ prefix.
cloudinary.config({
  cloud_name: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

interface CloudinaryUploadResult {
  public_id: string;
  bytes: number;
  duration?: number;
  [key: string]: number | string | unknown;
}

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json(
        { error: "User not authenticated" },
        { status: 401 }
      );
    }

    if (
      !process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ||
      !process.env.CLOUDINARY_API_SECRET ||
      !process.env.CLOUDINARY_API_KEY
    ) {
      return NextResponse.json(
        { error: "Cloudinary credentials not found" },
        { status: 500 }
      );
    }

    const limit = uploadRateLimiter.check(userId);
    if (!limit.allowed) {
      return tooManyRequests(limit.retryAfterSeconds);
    }

    const formData = await request.formData();
    const file = (formData.get("file") as File) || null;
    const title = formData.get("title") as string;
    const description = formData.get("description") as string;

    // The page checks the size too, but a client-side check is a courtesy, not
    // a control: the endpoint is reachable with curl.
    const validation = validateUpload(file, VIDEO_UPLOAD_RULES);
    if (!validation.ok) {
      return NextResponse.json(
        { error: validation.error },
        { status: validation.status }
      );
    }

    const bytes = await file!.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const result = await new Promise<CloudinaryUploadResult>(
      (resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            resource_type: "video",
            folder: "video-uploads",
            transformation: [{ quality: "auto", fetch_format: "mp4" }],
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result as CloudinaryUploadResult);
          }
        );
        uploadStream.end(buffer);
      }
    );

    const video = await prisma.video.create({
      data: {
        userId,
        title,
        description,
        publicId: result.public_id,
        // Measured server-side. The original size used to be read from a form
        // field, so the compression figure was whatever the client claimed, and
        // a request that omitted the field failed on a NOT NULL column.
        originalSize: String(buffer.length),
        compressedSize: String(result.bytes),
        duration: result.duration || 0,
      },
    });
    return NextResponse.json(video);
  } catch (error) {
    console.error("Upload video failed", error);
    return NextResponse.json(
      { error: "Error uploading video" },
      { status: 500 }
    );
  }
}
