-- Adds ownership to Video. Until now every signed-in user saw, downloaded and
-- could delete every other user's uploads, because no query filtered by user.
--
-- `prisma migrate diff` emits a single ADD COLUMN ... NOT NULL, which aborts on
-- a table that already has rows. Rows created before this migration have no
-- recoverable owner, so they are tagged and left in place for a human to
-- reassign or delete; they simply stop appearing in anyone's list.
ALTER TABLE "Video" ADD COLUMN "userId" TEXT;

UPDATE "Video" SET "userId" = 'legacy-unknown-owner' WHERE "userId" IS NULL;

ALTER TABLE "Video" ALTER COLUMN "userId" SET NOT NULL;

-- Matches the list query: filter by owner, newest first.
CREATE INDEX "Video_userId_createdAt_idx" ON "Video"("userId", "createdAt");
