import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

/**
 * The dashboard has always had a delete button, but no route answered
 * DELETE /api/videos/:id, so every click 404'd.
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
    // deleteMany rather than delete: the ownership filter and the delete happen
    // in one statement, and a row belonging to somebody else is reported as
    // "not found" rather than "forbidden", which would confirm it exists.
    const { count } = await prisma.video.deleteMany({ where: { id, userId } });
    if (count === 0) {
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    }
    return NextResponse.json({ id, deleted: true });
  } catch (error: unknown) {
    console.error("Error deleting video:", error);
    return NextResponse.json({ error: "Error deleting video" }, { status: 500 });
  }
}
