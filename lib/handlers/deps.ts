import type { RateLimitResult } from "../rateLimit";

/**
 * The pieces of the outside world a route handler is allowed to reach.
 *
 * Handlers are built by a factory that takes these, and each `route.ts` is one
 * line of wiring that passes the real ones in. The tests pass fakes and drive
 * the same handler function, so what is asserted is the code that actually
 * serves the request -- status codes, bodies and ordering included -- rather
 * than a re-implementation of it.
 */

/**
 * Structurally what Clerk's `auth()` returns. Typed as the one field the
 * handlers use so a test does not have to fabricate a whole Clerk session.
 */
export type AuthPort = () => Promise<{ userId: string | null }>;

export interface RateLimiterPort {
  check(key: string): RateLimitResult;
}

/** Next 15 hands dynamic segments to the handler as a promise. */
export type RouteContext<T> = { params: Promise<T> };
