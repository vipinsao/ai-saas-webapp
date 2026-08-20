/**
 * The quota, against a real PostgreSQL.
 *
 * tests/imageHandlers.test.ts proves the handler no longer decides and writes in
 * two steps, using the in-memory index — which is atomic for free, because
 * nothing runs between its read and its push. That is exactly what the Prisma
 * implementation has to buy with a lock, and nothing in an in-memory fake can
 * show whether it bought it. Hence this file.
 *
 * Skipped unless TEST_DATABASE_URL is set, because CI has no database:
 *
 *   TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:54329/cloudinary_saas" \
 *     npm test
 *
 * It writes and deletes rows under a user id of its own and touches nothing
 * else, but point it at a throwaway database anyway.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";

const CONNECTION = process.env.TEST_DATABASE_URL;
const skip = CONNECTION
  ? false
  : "set TEST_DATABASE_URL to run the database tests";

const USER = "quota_race_test_user";

describe("prismaImageIndex.createWithinQuota", { skip }, () => {
  let index: typeof import("../lib/prismaMediaIndex").prismaImageIndex;
  let prisma: typeof import("../lib/prisma").prisma;

  before(async () => {
    process.env.DATABASE_URL = CONNECTION;
    ({ prismaImageIndex: index } = await import("../lib/prismaMediaIndex"));
    ({ prisma } = await import("../lib/prisma"));
    await prisma.image.deleteMany({ where: { userId: USER } });
  });

  after(async () => {
    await prisma.image.deleteMany({ where: { userId: USER } });
    await prisma.$disconnect();
  });

  const row = (bytes: number) => ({
    id: crypto.randomBytes(16).toString("hex"),
    userId: USER,
    bytes,
    originalBytes: bytes * 4,
    width: 100,
    height: 100,
  });

  it("admits exactly what fits when eight uploads arrive together", async () => {
    // Eight at 60 bytes against a 300 byte quota. Read-then-write admitted all
    // eight: each read the same 0 and each wrote. Only five fit.
    await prisma.image.deleteMany({ where: { userId: USER } });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => index.createWithinQuota(row(60), 300))
    );

    const admitted = results.filter((result) => result.ok).length;
    assert.equal(admitted, 5, `expected exactly 5 admitted, got ${admitted}`);

    const stored = await index.usedBytes(USER);
    assert.equal(stored, 300, "the quota is a ceiling, not an average");
  });

  it("never stores more than the quota, whatever the sizes are", async () => {
    await prisma.image.deleteMany({ where: { userId: USER } });

    // Uneven sizes, so the answer cannot come out right by the numbers dividing
    // evenly. 7 x 45 = 315 against 200: some combination fits, none may exceed.
    const results = await Promise.all(
      Array.from({ length: 7 }, () => index.createWithinQuota(row(45), 200))
    );

    assert.equal(results.filter((result) => result.ok).length, 4);
    const stored = await index.usedBytes(USER);
    assert.ok(stored <= 200, `stored ${stored} bytes against a 200 byte quota`);
  });

  it("a refusal reports the position that refused it, and writes no row", async () => {
    await prisma.image.deleteMany({ where: { userId: USER } });
    await index.createWithinQuota(row(90), 100);

    const refused = await index.createWithinQuota(row(50), 100);

    assert.equal(refused.ok, false);
    assert.equal(refused.usedBytes, 90);
    assert.equal((await index.listOwned(USER)).length, 1);
  });

  it("one user's uploads do not block or count against another's", async () => {
    const other = `${USER}_other`;
    await prisma.image.deleteMany({ where: { userId: { in: [USER, other] } } });

    try {
      const [mine, theirs] = await Promise.all([
        index.createWithinQuota(row(90), 100),
        index.createWithinQuota({ ...row(90), userId: other }, 100),
      ]);

      assert.equal(mine.ok, true);
      assert.equal(theirs.ok, true, "a per-user lock must not serialise different users out");
    } finally {
      await prisma.image.deleteMany({ where: { userId: { in: [USER, other] } } });
    }
  });
});
