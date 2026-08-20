import {
  createVideoDeleteHandler,
  envCloudinaryProvider,
} from "@/lib/handlers/videos";
import { clerkAuth } from "@/lib/handlers/clerkAuth";
import { prismaVideoIndex } from "@/lib/prismaMediaIndex";

export const runtime = "nodejs";

/**
 * DELETE /api/videos/:id -- destroys the Cloudinary asset, then the row.
 * Deleting only the row left the video in Cloudinary for ever, billed against
 * the account's storage with nothing left that could name it.
 */
export const DELETE = createVideoDeleteHandler({
  auth: clerkAuth,
  index: prismaVideoIndex,
  cloudinary: () => envCloudinaryProvider(),
});
