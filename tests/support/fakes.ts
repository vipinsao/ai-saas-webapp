/**
 * In-memory stand-ins for the two ports in lib/mediaIndex.ts and for the
 * Cloudinary client.
 *
 * They are deliberately dumb: they store rows in an array and filter them the
 * same way the Prisma implementation filters them. What the handler tests prove
 * is the handler's behaviour -- ordering, status codes, what is written and in
 * which order -- not Prisma's. The queries themselves are checked by reading
 * lib/prismaMediaIndex.ts, and are listed as unverified in the report.
 */
import { createRateLimiter } from "../../lib/rateLimit";
import type {
  CloudinaryClient,
  CloudinaryDestroyResult,
  CloudinaryUploadResult,
} from "../../lib/cloudinary";
import type { ImageIndex, ImageRecord, VideoIndex, VideoRecord } from "../../lib/mediaIndex";

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

    /**
     * Atomic by construction: this reads and writes with no `await` in between,
     * so nothing else can run between the sum and the push. That is the whole
     * property the real implementation has to buy with an advisory lock.
     */
    async createWithinQuota(row, quotaBytes) {
      if (index.failNextCreate) {
        index.failNextCreate = false;
        throw new Error("simulated index write failure");
      }
      const usedBytes = rows
        .filter((existing) => existing.userId === row.userId)
        .reduce((total, existing) => total + existing.bytes, 0);

      if (usedBytes + row.bytes > quotaBytes) return { ok: false as const, usedBytes };

      const record: ImageRecord = { ...row, createdAt: new Date() };
      rows.push(record);
      return { ok: true as const, record, usedBytes: usedBytes + row.bytes };
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
      return rows.map((row) => ({ id: row.id, userId: row.userId, createdAt: row.createdAt }));
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

export interface FakeVideoIndex extends VideoIndex {
  rows: VideoRecord[];
  failNextCreate: boolean;
}

export function createFakeVideoIndex(seed: VideoRecord[] = []): FakeVideoIndex {
  const rows: VideoRecord[] = [...seed];
  let nextId = seed.length + 1;

  const index: FakeVideoIndex = {
    rows,
    failNextCreate: false,

    async create(row) {
      if (index.failNextCreate) {
        index.failNextCreate = false;
        throw new Error("simulated index write failure");
      }
      const record: VideoRecord = {
        id: `vid_${nextId++}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...row,
      };
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
  };

  return index;
}

export function videoRecord(
  overrides: Partial<VideoRecord> & Pick<VideoRecord, "id" | "userId" | "publicId">
): VideoRecord {
  return {
    title: "A video",
    description: null,
    originalSize: "1000",
    compressedSize: "500",
    duration: 12,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

export interface FakeCloudinary extends CloudinaryClient {
  uploads: Array<{ bytes: number; folder: string }>;
  destroyed: string[];
  /** Rejected by the next uploadVideo call, then cleared. */
  uploadError: unknown;
  /** Rejected by the next destroyVideo call, then cleared. */
  destroyError: unknown;
  /** What destroyVideo answers when it does not reject. */
  destroyResult: CloudinaryDestroyResult;
  nextResult: CloudinaryUploadResult;
}

export function createFakeCloudinary(
  nextResult: CloudinaryUploadResult = { public_id: "video-uploads/abc", bytes: 500, duration: 12 }
): FakeCloudinary {
  const fake: FakeCloudinary = {
    uploads: [],
    destroyed: [],
    uploadError: null,
    destroyError: null,
    destroyResult: { result: "ok" },
    nextResult,

    async uploadVideo(buffer, options) {
      if (fake.uploadError) {
        const error = fake.uploadError;
        fake.uploadError = null;
        throw error;
      }
      fake.uploads.push({ bytes: buffer.length, folder: options.folder });
      return fake.nextResult;
    },

    videoUrls(publicId, title) {
      return {
        thumbnailUrl: `https://cdn.test/${publicId}/thumb?sig=fake`,
        previewUrl: `https://cdn.test/${publicId}/preview?sig=fake`,
        downloadUrl: `https://cdn.test/${publicId}/download/${title}?sig=fake`,
      };
    },

    async destroyVideo(publicId) {
      if (fake.destroyError) {
        const error = fake.destroyError;
        fake.destroyError = null;
        throw error;
      }
      fake.destroyed.push(publicId);
      return fake.destroyResult;
    },
  };

  return fake;
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
