import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  // The middleware already rejects anonymous API calls, but the handler repeats
  // the check so the route is still safe if the matcher config ever changes.
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const videos = await prisma.video.findMany({
      // Scoped to the caller. Without this filter every account saw every
      // other account's uploads.
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(videos);
  } catch (error: unknown) {
    console.error("Error fetching videos:", error);
    return NextResponse.json(
      { error: "Error fetching videos" },
      { status: 500 }
    );
  }
}
