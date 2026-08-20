import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
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
/** Every stored file is WebP; the pipeline re-encodes whatever was uploaded. */
const FILE_EXTENSION = ".webp";
const OWNER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function defaultStorageRoot(): string {
  // `??` alone is wrong here: `.env.example` ships IMAGE_STORAGE_DIR="" so a
  // reader can see the name and the default, and dotenv turns that into "".
  // An empty string is "not configured", not "store at the filesystem root" --
  // left as `??` it resolved to "", which put uploads in the process's working
  // directory and made the reaper refuse every sweep.
  const configured = process.env.IMAGE_STORAGE_DIR?.trim();
  return configured ? configured : path.join(process.cwd(), "storage", "uploads");
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
  return path.join(root, ownerId, `${imageId}${FILE_EXTENSION}`);
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

/**
 * Removes one stored file. Returns false when there was nothing to remove.
 *
 * A missing file is not an error here. The delete endpoint drops the index row
 * first (see lib/handlers/images.ts for why), so a retried delete, or a delete
 * of a file the reaper already collected, arrives with the row gone and the
 * file gone. That is the intended end state, not a failure.
 */
export async function deleteImage(
  ownerId: string,
  imageId: string,
  root = defaultStorageRoot()
): Promise<boolean> {
  const target = resolveImagePath(ownerId, imageId, root);
  try {
    await unlink(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export interface StoredFile {
  ownerId: string;
  imageId: string;
  bytes: number;
  /** Last-modified time in epoch milliseconds, used by the reaper's grace window. */
  modifiedAtMs: number;
}

/**
 * Walks the store and yields every file that looks like one of ours.
 *
 * This is the half of the reaper that finds files with no row. Anything whose
 * directory or filename does not match the two id patterns is skipped rather
 * than deleted: the reaper only removes files it can prove it owns the naming
 * scheme of, so an unrelated file dropped in the directory is left alone
 * instead of being destroyed by a maintenance job.
 */
export async function listStoredImages(root = defaultStorageRoot()): Promise<StoredFile[]> {
  let owners: string[];
  try {
    owners = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isValidOwnerId(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    // An empty store is a store with nothing to reap, not a crash.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const found: StoredFile[] = [];
  for (const ownerId of owners) {
    const dir = path.join(root, ownerId);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(FILE_EXTENSION)) continue;
      const imageId = entry.name.slice(0, -FILE_EXTENSION.length);
      if (!isValidImageId(imageId)) continue;
      const info = await stat(path.join(dir, entry.name));
      found.push({ ownerId, imageId, bytes: info.size, modifiedAtMs: info.mtimeMs });
    }
  }
  return found;
}
