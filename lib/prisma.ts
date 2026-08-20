import { PrismaClient } from "@prisma/client";

/**
 * Next.js re-evaluates modules on every hot reload in development. Constructing
 * a PrismaClient at module scope therefore opens a brand new connection pool on
 * each reload until Postgres starts refusing connections. Caching the instance
 * on globalThis keeps exactly one pool per process.
 *
 * https://www.prisma.io/docs/orm/more/help-and-troubleshooting/nextjs-help
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
