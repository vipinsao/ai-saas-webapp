import { createImageUploadHandler } from "@/lib/handlers/images";
import { clerkAuth } from "@/lib/handlers/clerkAuth";
import { prismaImageIndex } from "@/lib/prismaMediaIndex";

// sharp is a native module, so this handler must not run on the edge runtime.
export const runtime = "nodejs";

// The handler itself lives in lib/handlers/images.ts so the tests can run it
// with an in-memory index and a temp directory. This file is the wiring.
export const POST = createImageUploadHandler({
  auth: clerkAuth,
  index: prismaImageIndex,
});
