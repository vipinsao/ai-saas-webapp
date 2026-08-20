import { createImageListHandler } from "@/lib/handlers/images";
import { clerkAuth } from "@/lib/handlers/clerkAuth";
import { prismaImageIndex } from "@/lib/prismaMediaIndex";

export const runtime = "nodejs";

// GET /api/images -- the caller's uploads and how much of their quota is used.
// Until this existed an upload was write-only: the browser held the id in React
// state and lost it on reload, so no user could ever list or delete a file.
export const GET = createImageListHandler({
  auth: clerkAuth,
  index: prismaImageIndex,
});
