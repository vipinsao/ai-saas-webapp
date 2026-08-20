import { createVideoListHandler, envCloudinaryProvider } from "@/lib/handlers/videos";
import { clerkAuth } from "@/lib/handlers/clerkAuth";
import { prismaVideoIndex } from "@/lib/prismaMediaIndex";

export const runtime = "nodejs";

/**
 * GET /api/videos -- the caller's videos with signed delivery URLs.
 *
 * The response no longer carries `publicId`. Uploads are `type:
 * "authenticated"` now, and the signature that makes a delivery URL work is
 * computed from the API secret, which stays on this side.
 */
export const GET = createVideoListHandler({
  auth: clerkAuth,
  index: prismaVideoIndex,
  cloudinary: () => envCloudinaryProvider(),
});
