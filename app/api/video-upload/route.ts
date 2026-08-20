import {
  createVideoUploadHandler,
  envCloudinaryProvider,
} from "@/lib/handlers/videos";
import { clerkAuth } from "@/lib/handlers/clerkAuth";
import { prismaVideoIndex } from "@/lib/prismaMediaIndex";

export const runtime = "nodejs";

export const POST = createVideoUploadHandler({
  auth: clerkAuth,
  index: prismaVideoIndex,
  // Read per request, not at module load: a variable that is missing or
  // misspelled becomes a named 503 instead of a client configured with
  // `undefined` and a generic 500 later on.
  cloudinary: () => envCloudinaryProvider(),
});
