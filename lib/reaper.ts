import { deleteImage, listStoredImages, defaultStorageRoot } from "./imageStore";
import type { ImageIndex } from "./mediaIndex";

/**
 * Reconciles the image store against its index, in both directions.
 *
 * Neither direction should happen while the app is behaving, because the two
 * write orders are chosen to keep the index and the disk in step:
 *
 *   upload  -> write the file, then insert the row
 *   delete  -> delete the row, then unlink the file
 *
 * Both orders fail towards the same residue: a file with no row. That is on
 * purpose. A file nobody points at is invisible and merely wastes disk, and it
 * is recoverable because the filesystem can be enumerated. The opposite residue
 * -- a row whose file is gone -- is user-visible corruption: it shows up in the
 * listing, is counted against the quota, and 404s when opened.
 *
 * So the file->row direction is the expected garbage after a crash, and this
 * job collects it. The row->file direction is not something this code can
 * produce; it comes from outside (a restored database dump against a wiped
 * volume, a hand-run `rm`, a container that lost an ephemeral filesystem).
 * It is reaped too, because the alternative is leaving broken entries in a
 * user's list and charging them quota for bytes that no longer exist.
 */

export interface OrphanFile {
  ownerId: string;
  imageId: string;
  bytes: number;
}

export interface OrphanRow {
  userId: string;
  id: string;
}

export interface ReapReport {
  scannedFiles: number;
  scannedRows: number;
  /** Files with no row. Deleted unless dryRun. */
  orphanFiles: OrphanFile[];
  /** Rows with no file. Deleted unless dryRun. */
  orphanRows: OrphanRow[];
  /** Bytes freed from disk. 0 on a dry run. */
  bytesReclaimed: number;
  /** Files that had no row but were too new to touch -- see graceMs. */
  skippedTooNew: number;
  dryRun: boolean;
}

export interface ReapOptions {
  index: Pick<ImageIndex, "listAll" | "deleteByIds">;
  root?: string;
  /**
   * An upload writes the file before it writes the row, so there is a short
   * window in which a perfectly healthy file legitimately has no row. Without
   * a grace period the reaper would race a live upload and delete the bytes
   * out from under it. Default 15 minutes: far longer than any request, far
   * shorter than "forever".
   */
  graceMs?: number;
  now?: () => number;
  /** Report what would be removed without removing it. */
  dryRun?: boolean;
}

const DEFAULT_GRACE_MS = 15 * 60 * 1000;

function key(ownerId: string, imageId: string): string {
  return `${ownerId}/${imageId}`;
}

export async function reapOrphans({
  index,
  root = defaultStorageRoot(),
  graceMs = DEFAULT_GRACE_MS,
  now = Date.now,
  dryRun = false,
}: ReapOptions): Promise<ReapReport> {
  const files = await listStoredImages(root);
  const rows = await index.listAll();

  const rowKeys = new Set(rows.map((row) => key(row.userId, row.id)));
  const fileKeys = new Set(files.map((file) => key(file.ownerId, file.imageId)));

  const cutoff = now() - graceMs;
  const orphanFiles: OrphanFile[] = [];
  let skippedTooNew = 0;

  for (const file of files) {
    if (rowKeys.has(key(file.ownerId, file.imageId))) continue;
    if (file.modifiedAtMs > cutoff) {
      skippedTooNew += 1;
      continue;
    }
    orphanFiles.push({ ownerId: file.ownerId, imageId: file.imageId, bytes: file.bytes });
  }

  const orphanRows: OrphanRow[] = rows
    .filter((row) => !fileKeys.has(key(row.userId, row.id)))
    .map((row) => ({ userId: row.userId, id: row.id }));

  let bytesReclaimed = 0;
  if (!dryRun) {
    for (const orphan of orphanFiles) {
      // Already gone is the desired state; deleteImage reports false rather
      // than throwing, so a concurrent delete does not fail the whole sweep.
      if (await deleteImage(orphan.ownerId, orphan.imageId, root)) {
        bytesReclaimed += orphan.bytes;
      }
    }
    if (orphanRows.length > 0) {
      await index.deleteByIds(orphanRows.map((row) => row.id));
    }
  }

  return {
    scannedFiles: files.length,
    scannedRows: rows.length,
    orphanFiles,
    orphanRows,
    bytesReclaimed,
    skippedTooNew,
    dryRun,
  };
}
