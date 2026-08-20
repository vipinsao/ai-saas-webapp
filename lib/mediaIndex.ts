/**
 * The database seen as two narrow ports.
 *
 * Route handlers depend on these interfaces, not on Prisma. That is what lets
 * the handler tests run the real handler code with an in-memory index, with no
 * Postgres and no migration — the same reason lib/imageStore.ts exists as a
 * module instead of `fs` calls inlined in a route.
 *
 * The Prisma implementations are in lib/prismaMediaIndex.ts, which is imported
 * only by the route files.
 */

export interface ImageRecord {
  id: string;
  userId: string;
  /** Bytes of the stored WebP. The quota counts this column. */
  bytes: number;
  originalBytes: number;
  width: number;
  height: number;
  createdAt: Date;
}

export interface ImageIndex {
  create(row: Omit<ImageRecord, "createdAt">): Promise<ImageRecord>;
  /** Scoped read. Returns null for another user's id, exactly as for a missing one. */
  findOwned(userId: string, id: string): Promise<ImageRecord | null>;
  listOwned(userId: string): Promise<ImageRecord[]>;
  /**
   * Number of rows removed: 0 means "not yours or not there". The ownership
   * filter and the delete are one statement, so there is no read-then-write
   * window in which the row could change hands.
   */
  deleteOwned(userId: string, id: string): Promise<number>;
  /** Sum of `bytes` for one user. 0 when the user has nothing stored. */
  usedBytes(userId: string): Promise<number>;

  // --- used by the reaper only, deliberately not owner-scoped ---------------
  /**
   * `createdAt` is here so the reaper can apply the same grace window to rows
   * that it applies to files. Without it a row written moments ago looks
   * identical to a row whose file was lost months ago.
   */
  listAll(): Promise<Array<Pick<ImageRecord, "id" | "userId" | "createdAt">>>;
  deleteByIds(ids: string[]): Promise<number>;
}

export interface VideoRecord {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  /** Cloudinary's handle for the remote asset. The only way to reach it. */
  publicId: string;
  originalSize: string;
  compressedSize: string;
  duration: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface VideoIndex {
  create(row: {
    userId: string;
    title: string;
    description: string | null;
    publicId: string;
    originalSize: string;
    compressedSize: string;
    duration: number;
  }): Promise<VideoRecord>;
  findOwned(userId: string, id: string): Promise<VideoRecord | null>;
  listOwned(userId: string): Promise<VideoRecord[]>;
  deleteOwned(userId: string, id: string): Promise<number>;
}
