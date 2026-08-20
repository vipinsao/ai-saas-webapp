import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Clerk renders sign-in and sign-up on optional catch-all routes, and it
 * navigates to sub-paths during a flow (for example
 * /sign-up/verify-email-address for the emailed code). The matchers therefore
 * have to cover those sub-paths, otherwise the middleware bounces a
 * mid-flow user back to /sign-in and the flow can never complete.
 */
const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  const { userId } = await auth();
  const pathname = new URL(req.url).pathname;
  const isApiRequest = pathname.startsWith("/api");

  if (!userId) {
    // API callers get a status code they can branch on. Redirecting an XHR to
    // the sign-in page makes fetch/axios resolve with a 200 HTML document,
    // which the calling code then mistakes for a successful request.
    if (isApiRequest) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!isPublicRoute(req)) {
      return NextResponse.redirect(new URL("/sign-in", req.url));
    }
    return NextResponse.next();
  }

  // Signed in: the root page is unused boilerplate and the auth screens are
  // pointless, so send both to the dashboard.
  if (pathname === "/" || isPublicRoute(req)) {
    return NextResponse.redirect(new URL("/home", req.url));
  }

  return NextResponse.next();
});

export const config = {
  // First pattern: every page route except files (anything with a dot) and
  // Next internals. Second pattern: every API route, including ones whose path
  // contains a dot, which the first pattern would skip.
  matcher: ["/((?!.*\\..*|_next).*)", "/", "/(api|trpc)(.*)"],
};
