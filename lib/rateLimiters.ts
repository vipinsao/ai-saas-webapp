import { createRateLimiter } from "./rateLimit";
import { NextResponse } from "next/server";

/**
 * One limiter per endpoint class, keyed by Clerk user id.
 *
 * These live at module scope, so the counters are shared by every request the
 * process handles. They are not shared across processes — see DECISIONS.md.
 */
export const uploadRateLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
export const transformRateLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });

export function tooManyRequests(retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    {
      error: `Too many requests. Try again in ${retryAfterSeconds}s.`,
      retryAfterSeconds,
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
  );
}
