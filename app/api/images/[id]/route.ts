import {
  createImageDeleteHandler,
  createImageTransformHandler,
} from "@/lib/handlers/images";
import { clerkAuth } from "@/lib/handlers/clerkAuth";
import { prismaImageIndex } from "@/lib/prismaMediaIndex";

export const runtime = "nodejs";

const deps = { auth: clerkAuth, index: prismaImageIndex };

/** GET /api/images/:id?format=instagram-square[&download=1] */
export const GET = createImageTransformHandler(deps);

/** DELETE /api/images/:id -- removes the index row and then the file. */
export const DELETE = createImageDeleteHandler(deps);
