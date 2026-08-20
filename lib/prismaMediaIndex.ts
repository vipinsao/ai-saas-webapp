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
