/**
 * Fixed-window rate limiter held in process memory.
 *
 * Deliberately dependency-free and free to run: no Redis, no hosted quota
 * service. The trade-off is stated in DECISIONS.md — the counters live in one
 * Node process, so they reset on restart and are not shared between instances.
 * That is enough to stop a single browser hammering the upload endpoint, and
 * not enough to be a real abuse defence behind a load balancer.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in the current window after this one. */
  remaining: number;
  /** Seconds until the window resets. 0 when the request was allowed. */
  retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  /** Injectable clock so the tests do not have to sleep. */
  now?: () => number;
}

interface Window {
  count: number;
  resetAt: number;
}

export function createRateLimiter({ limit, windowMs, now = Date.now }: RateLimiterOptions) {
  const windows = new Map<string, Window>();

  function prune(currentTime: number) {
    for (const [key, window] of windows) {
      if (window.resetAt <= currentTime) windows.delete(key);
    }
  }

  return {
    check(key: string): RateLimitResult {
      const currentTime = now();

      // Keeps the map from growing without bound when many distinct users hit
      // the endpoint over a long-lived process.
      if (windows.size > 1000) prune(currentTime);

      const existing = windows.get(key);
      const window =
        existing && existing.resetAt > currentTime
          ? existing
          : { count: 0, resetAt: currentTime + windowMs };

      if (window.count >= limit) {
        windows.set(key, window);
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - currentTime) / 1000)),
        };
      }

      window.count += 1;
      windows.set(key, window);
      return {
        allowed: true,
        remaining: limit - window.count,
        retryAfterSeconds: 0,
      };
    },

    reset(): void {
      windows.clear();
    },
  };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
