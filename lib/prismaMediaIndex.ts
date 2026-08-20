import { prisma } from "./prisma";
import type { ImageIndex, VideoIndex } from "./mediaIndex";

/**
 * The production implementations of the two ports in lib/mediaIndex.ts.
 *
 * This module is the only place outside the reaper script that touches
 * `prisma.image` / `prisma.video`, so importing it is what pulls a database
 * connection into a module graph. Handlers do not import it; route files do.
 */

export const prismaImageIndex: ImageIndex = {
  create(row) {
    return prisma.image.create({ data: row });
  },

  /**
   * The quota decision and the insert, as one transaction that a second
   * uploader cannot interleave with.
   *
   * The advisory lock is what makes it atomic. Neither a plain transaction nor
   * a conditional INSERT would: under READ COMMITTED both concurrent callers
   * evaluate `SUM(bytes)` against their own snapshot, and Postgres cannot lock
   * rows that do not exist yet, so there is nothing for the second one to block
   * on. `pg_advisory_xact_lock` gives them something — a lock derived from the
   * user id, so two uploads by the same user serialise and two uploads by
   * different users do not contend at all. It is transaction-scoped, so it is
   * released by the commit or the rollback and cannot leak.
   */
  async createWithinQuota(row, quotaBytes) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${row.userId}, 0))`;

      const { _sum } = await tx.image.aggregate({
        _sum: { bytes: true },
        where: { userId: row.userId },
      });
      const usedBytes = _sum.bytes ?? 0;

      if (usedBytes + row.bytes > quotaBytes) {
        return { ok: false as const, usedBytes };
      }

      const record = await tx.image.create({ data: row });
      return { ok: true as const, record, usedBytes: usedBytes + row.bytes };
    });
  },

  findOwned(userId, id) {
    // findFirst, not findUnique: the owner has to be part of the predicate, or
    // the id alone would return another user's row and leave the check to the
    // caller to remember.
    return prisma.image.findFirst({ where: { id, userId } });
  },

  listOwned(userId) {
    return prisma.image.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  },

  async deleteOwned(userId, id) {
    const { count } = await prisma.image.deleteMany({ where: { id, userId } });
    return count;
  },

  async usedBytes(userId) {
    const result = await prisma.image.aggregate({
      _sum: { bytes: true },
      where: { userId },
    });
    // _sum is null when no rows matched, which is a user with nothing stored.
    return result._sum.bytes ?? 0;
  },

  listAll() {
    return prisma.image.findMany({ select: { id: true, userId: true, createdAt: true } });
  },

  async deleteByIds(ids) {
    if (ids.length === 0) return 0;
    const { count } = await prisma.image.deleteMany({ where: { id: { in: ids } } });
    return count;
  },
};

export const prismaVideoIndex: VideoIndex = {
  create(row) {
    return prisma.video.create({ data: row });
  },

  findOwned(userId, id) {
    return prisma.video.findFirst({ where: { id, userId } });
  },

  listOwned(userId) {
    return prisma.video.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  },

  async deleteOwned(userId, id) {
    const { count } = await prisma.video.deleteMany({ where: { id, userId } });
    return count;
  },
};
