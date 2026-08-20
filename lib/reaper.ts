import { stat } from "node:fs/promises";
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
 *
 * ---------------------------------------------------------------------------
 * THE ROW SIDE IS THE DANGEROUS ONE, AND IT IS GUARDED THREE WAYS.
 *
 * Deleting an orphan file costs one image. Deleting orphan rows costs the whole
 * index if the scan comes back empty for a reason that has nothing to do with
 * the rows -- and "the storage directory is not there" is exactly such a
 * reason. The default root is `process.cwd()/storage/uploads`; an ephemeral
 * filesystem, a fresh deploy, an unset IMAGE_STORAGE_DIR or a process started
 * from the wrong directory all produce ENOENT, `listStoredImages` answers `[]`
 * because an empty store is not a crash, and every row in the table then looks
 * like an orphan. The first version of this file did precisely that.
 *
 *   1. the root must exist and be a directory, or the sweep refuses to run;
 *   2. zero files with rows still present is treated as a broken scan, not as
 *      a table full of orphans -- it refuses rather than guesses;
 *   3. rows younger than the grace window are skipped, for the same reason
 *      young files are.
 *
 * Rows are also read BEFORE the directory is scanned. An upload writes its file
 * and then its row, so reading rows first means any row this sweep considers
 * had its file written before the scan started -- closing the window where an
 * upload landing mid-sweep would have looked like a row with no file.
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
  skippedFilesTooNew: number;
  /** Rows that had no file but were too new to touch. */
  skippedRowsTooNew: number;
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

/**
 * Thrown instead of deleting when the storage scan cannot be trusted. A sweep
 * that refuses to run is an alert; a sweep that runs on a bad scan is a
 * restore-from-backup.
 */
export class UntrustworthyScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustworthyScanError";
  }
}

async function assertRootUsable(root: string): Promise<void> {
  let info;
  try {
    info = await stat(root);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new UntrustworthyScanError(
      `Refusing to reap: the storage root ${root} could not be read (${code}). ` +
        `Every row in the index would look like an orphan. Check IMAGE_STORAGE_DIR ` +
        `and the working directory the job runs from.`
    );
  }
  if (!info.isDirectory()) {
    throw new UntrustworthyScanError(
      `Refusing to reap: the storage root ${root} is not a directory.`
    );
  }
}

export async function reapOrphans({
  index,
  root = defaultStorageRoot(),
  graceMs = DEFAULT_GRACE_MS,
  now = Date.now,
  dryRun = false,
}: ReapOptions): Promise<ReapReport> {
  await assertRootUsable(root);

  // Rows first, then files -- see the note at the top of this file.
  const rows = await index.listAll();
  const files = await listStoredImages(root);

  if (files.length === 0 && rows.length > 0) {
    throw new UntrustworthyScanError(
      `Refusing to reap: the storage root ${root} holds no images but the index ` +
        `has ${rows.length} row(s). That is a broken or empty mount far more often ` +
        `than it is ${rows.length} genuinely orphaned row(s), and the cost of ` +
        `guessing wrong is the whole index. Delete the rows by hand if the loss ` +
        `is real.`
    );
  }

  const rowKeys = new Set(rows.map((row) => key(row.userId, row.id)));
  const fileKeys = new Set(files.map((file) => key(file.ownerId, file.imageId)));

  const cutoff = now() - graceMs;
  const orphanFiles: OrphanFile[] = [];
  let skippedFilesTooNew = 0;

  for (const file of files) {
    if (rowKeys.has(key(file.ownerId, file.imageId))) continue;
    if (file.modifiedAtMs > cutoff) {
      skippedFilesTooNew += 1;
      continue;
    }
    orphanFiles.push({ ownerId: file.ownerId, imageId: file.imageId, bytes: file.bytes });
  }

  const orphanRows: OrphanRow[] = [];
  let skippedRowsTooNew = 0;

  for (const row of rows) {
    if (fileKeys.has(key(row.userId, row.id))) continue;
    if (row.createdAt.getTime() > cutoff) {
      skippedRowsTooNew += 1;
      continue;
    }
    orphanRows.push({ userId: row.userId, id: row.id });
  }

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
    skippedFilesTooNew,
    skippedRowsTooNew,
    dryRun,
  };
}
