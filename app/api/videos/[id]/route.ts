import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * The dashboard has always had a delete button, but no route answered
 * DELETE /api/videos/:id, so every click 404'd and the card silently
 * disappeared from the list until the next refresh.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Video id is required" }, { status: 400 });
  }

  try {
    await prisma.video.delete({ where: { id } });
    return NextResponse.json({ id, deleted: true });
  } catch (error: unknown) {
    // P2025 is Prisma's "record to delete does not exist".
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }
    console.error("Error deleting video:", error);
    return NextResponse.json(
      { error: "Error deleting video" },
      { status: 500 }
    );
  }
}
