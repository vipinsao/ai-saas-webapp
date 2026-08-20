import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Uploads are kept on the local filesystem, one directory per signed-in user:
 *
 *   <root>/<userId>/<imageId>.webp
 *
 * Putting the owner in the path means a read is scoped by construction: the
 * handler only ever builds a path from the Clerk user id of the current
 * request, so one user cannot address another user's file by guessing an id.
 */

const ID_PATTERN = /^[0-9a-f]{32}$/;
const OWNER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function defaultStorageRoot(): string {
  return process.env.IMAGE_STORAGE_DIR ?? path.join(process.cwd(), "storage", "uploads");
}

export function newImageId(): string {
  return randomBytes(16).toString("hex");
}

export function isValidImageId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function isValidOwnerId(ownerId: string): boolean {
  return OWNER_PATTERN.test(ownerId);
}

/**
 * Both segments are validated against a strict allowlist before they are joined
 * with the storage root. Without this an id of "../../.env" would resolve to a
 * file outside the store.
 */
export function resolveImagePath(ownerId: string, imageId: string, root = defaultStorageRoot()): string {
  if (!isValidOwnerId(ownerId)) throw new Error("Invalid owner id");
  if (!isValidImageId(imageId)) throw new Error("Invalid image id");
  return path.join(root, ownerId, `${imageId}.webp`);
}

export async function saveImage(
  ownerId: string,
  imageId: string,
  data: Buffer,
  root = defaultStorageRoot()
): Promise<string> {
  const target = resolveImagePath(ownerId, imageId, root);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
  return target;
}

/** Returns null when the image does not exist, rather than throwing ENOENT. */
export async function readImage(
  ownerId: string,
  imageId: string,
  root = defaultStorageRoot()
): Promise<Buffer | null> {
  const target = resolveImagePath(ownerId, imageId, root);
  try {
    return await readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
