/**
 * In-memory stand-ins for the ports in lib/mediaIndex.ts.
 *
 * They are deliberately dumb: they store rows in an array and filter them the
 * same way the Prisma implementation filters them. What the handler tests prove
 * is the handler's behaviour -- ordering, status codes, what is written and in
 * which order -- not Prisma's. The queries themselves are checked by reading
 * lib/prismaMediaIndex.ts, and are listed as unverified in the report.
 */
import { createRateLimiter } from "../../lib/rateLimit";
import type { ImageIndex, ImageRecord } from "../../lib/mediaIndex";

export interface FakeImageIndex extends ImageIndex {
  rows: ImageRecord[];
  /** Set to make the next create() reject, exercising the compensating unlink. */
  failNextCreate: boolean;
}

export function createFakeImageIndex(seed: ImageRecord[] = []): FakeImageIndex {
  const rows: ImageRecord[] = [...seed];

  const index: FakeImageIndex = {
    rows,
    failNextCreate: false,

    async create(row) {
      if (index.failNextCreate) {
        index.failNextCreate = false;
        throw new Error("simulated index write failure");
      }
      const record: ImageRecord = { ...row, createdAt: new Date() };
      rows.push(record);
      return record;
    },

    async findOwned(userId, id) {
      return rows.find((row) => row.id === id && row.userId === userId) ?? null;
    },

    async listOwned(userId) {
      return rows
        .filter((row) => row.userId === userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    async deleteOwned(userId, id) {
      const at = rows.findIndex((row) => row.id === id && row.userId === userId);
      if (at === -1) return 0;
      rows.splice(at, 1);
      return 1;
    },

    async usedBytes(userId) {
      return rows
        .filter((row) => row.userId === userId)
        .reduce((total, row) => total + row.bytes, 0);
    },

    async listAll() {
      return rows.map((row) => ({ id: row.id, userId: row.userId }));
    },

    async deleteByIds(ids) {
      const before = rows.length;
      for (const id of ids) {
        const at = rows.findIndex((row) => row.id === id);
        if (at !== -1) rows.splice(at, 1);
      }
      return before - rows.length;
    },
  };

  return index;
}

export function imageRecord(overrides: Partial<ImageRecord> & Pick<ImageRecord, "id" | "userId">): ImageRecord {
  return {
    bytes: 1000,
    originalBytes: 4000,
    width: 100,
    height: 100,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** A limiter with a high ceiling, so a test never trips it by accident. */
export function permissiveLimiter() {
  return createRateLimiter({ limit: 10_000, windowMs: 60_000 });
}

export function signedInAs(userId: string | null) {
  return async () => ({ userId });
}

/**
 * Several handlers log to console.error on the paths that are deliberately
 * exercised here. Silencing it keeps the test output readable without hiding
 * the logging from production.
 */
export function silenceConsoleError(): () => void {
  const original = console.error;
  console.error = () => {};
  return () => {
    console.error = original;
  };
}
