-- Gives stored images an index row.
--
-- Uploads were written to disk and nothing recorded them, so there was no
-- owner-scoped way to list or delete one: every file ever uploaded stayed on
-- disk forever. This table is that record. The primary key is the same 32-hex
-- value as the filename, so a row and its file locate each other directly.

-- CreateTable
CREATE TABLE "Image" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "originalBytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Image_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Image_userId_createdAt_idx" ON "Image"("userId", "createdAt");

