/**
 * Per-user cap on the local image store.
 *
 * The per-file limit in lib/uploadValidation.ts stops one enormous upload; it
 * does nothing about ten thousand small ones. Without a total, a single account
 * can fill the disk one 9 MB file at a time and take the process down with it.
 *
 * This covers the image store only. Video bytes live in Cloudinary and are
 * governed by that account's own plan limits, which this app cannot see or
 * enforce from a request handler.
 */

import type { EnvLike } from "./env";

export const DEFAULT_STORAGE_QUOTA_BYTES = 100 * 1024 * 1024; // 100 MB per user

/**
 * Reads the cap from the environment at call time rather than at module load,
 * so a test can set it without having to reset module state.
 */
export function storageQuotaBytes(env: EnvLike = process.env): number {
  const raw = env.IMAGE_STORAGE_QUOTA_BYTES;
  if (!raw) return DEFAULT_STORAGE_QUOTA_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_STORAGE_QUOTA_BYTES;
  return Math.floor(parsed);
}

export interface QuotaState {
  /** Sum of the `bytes` column for this user, i.e. what the index says is stored. */
  usedBytes: number;
  /** Size of the file about to be written. */
  incomingBytes: number;
  quotaBytes: number;
}

export type QuotaCheck =
  | { ok: true; usedBytes: number; quotaBytes: number; remainingBytes: number }
  | {
      ok: false;
      /**
       * 507, not 413. A 413 tells the client "this request was too big, send a
       * smaller one", which is misleading here: the request may be tiny and
       * still fail, and it will keep failing until the user deletes something.
       * 507 Insufficient Storage says the store is full, which is the actual
       * situation and points at the actual remedy.
       */
      status: 507;
      error: string;
      usedBytes: number;
      quotaBytes: number;
      remainingBytes: number;
    };

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function checkQuota({ usedBytes, incomingBytes, quotaBytes }: QuotaState): QuotaCheck {
  const remainingBytes = Math.max(0, quotaBytes - usedBytes);

  if (usedBytes + incomingBytes > quotaBytes) {
    return {
      ok: false,
      status: 507,
      error:
        `Storage quota exceeded. This file needs ${megabytes(incomingBytes)}, ` +
        `you have ${megabytes(remainingBytes)} left of ${megabytes(quotaBytes)}. ` +
        `Delete an image to free space.`,
      usedBytes,
      quotaBytes,
      remainingBytes,
    };
  }

  return { ok: true, usedBytes, quotaBytes, remainingBytes };
}
