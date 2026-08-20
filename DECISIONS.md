# Decisions

Short notes on the choices in this repo that are not obvious from the code, and
what each one costs.

## Images are processed locally with `sharp`; video still goes to Cloudinary

The app originally sent both images and video to Cloudinary and used
`next-cloudinary` to build transformation URLs. Images are now decoded, cropped
and re-encoded in-process by [`sharp`](https://sharp.pixelplumbing.com/)
(Apache-2.0, wrapping libvips), and written to the local filesystem. The
prebuilt libvips binaries `sharp` pulls in (`@img/sharp-libvips-*`) are
LGPL-3.0-or-later; they are used as a shared library, not modified.

Why:

- **No signup for the image half.** `sharp` installs from npm with prebuilt
  libvips binaries. Cloning the repo and using the image features needs no
  account anywhere and no network access at request time.
- **The crop logic becomes testable.** A Cloudinary URL is an assertion about
  what a remote service will do; you can only test it by fetching it.
  `transformToSocialFormat()` is a function that takes a `Buffer` and returns a
  `Buffer`, so `tests/imagePipeline.test.ts` asserts exact output dimensions for
  every preset against a committed fixture, with no network.
- **Upload validation gets real.** Decoding the bytes is what proves a file is
  an image. A `Content-Type` header is whatever the client typed.

Video stays on Cloudinary because `sharp` does not touch video. The free
alternative is bundling `ffmpeg`, which is a much larger system dependency, a
much longer request, and a job that belongs in a queue rather than in a request
handler. That was out of scope for this project — see "Not built" below.

**Cloudinary free tier**, confirmed at <https://cloudinary.com/pricing> on
2026-08-20: "No credit card required", 3 users / 1 account, 25 monthly credits,
where one credit is interchangeably 1,000 transformations, 1 GB of managed
storage, or 1 GB of CDN video bandwidth. The video features fit inside that for
demo use. If you do not want a Cloudinary account at all, leave the Cloudinary
variables blank: the image features work, and `/api/video-upload` returns a
clear 500 saying the credentials are missing.

## Local disk as the image store, with the owner in the path

Uploads land at `<IMAGE_STORAGE_DIR>/<clerkUserId>/<imageId>.webp`.

Putting the user id in the path means an authorisation check is not something a
handler can forget: `readImage()` is only ever called with the Clerk user id of
the current request, so another user's file is not addressable even if the
image id is guessed. Both path segments are matched against strict patterns
(`^[0-9a-f]{32}$` for the id, `^[A-Za-z0-9_-]{1,128}$` for the owner) before
they are joined to the root, so `../../.env` is rejected rather than resolved.

The cost is that this does not survive a container restart on an ephemeral
filesystem and does not work across more than one instance. For a portfolio
app run locally that is the right trade; a deployment would swap
`lib/imageStore.ts` for object storage, which is the reason the filesystem
calls are behind that module instead of inline in the route.

Transforms are computed on request rather than precomputed at upload time. That
costs CPU per view and saves storage, and it means adding a preset to
`lib/socialFormats.ts` needs no migration and no backfill.

## Rate limiting is in-process, on purpose

`lib/rateLimit.ts` is a fixed-window counter in a `Map`. No Redis, no hosted
quota service, nothing to pay for.

It is honest about what it is: the counters live in one Node process, so they
reset when the server restarts and are not shared between instances. Behind a
load balancer with N instances the effective limit is N times the configured
one. It stops one browser hammering the upload endpoint, which is the threat a
single-instance app actually has. Anything stronger needs shared state, and
shared state needs a service.

The clock is injected (`now?: () => number`) so the window-expiry behaviour is
asserted in tests without sleeping.

## Auth is checked twice

`middleware.ts` rejects anonymous API requests, and every route handler calls
`auth()` again. The duplication is deliberate: the middleware protects routes
by URL pattern, and a `matcher` edit can silently stop covering a path. The
handler check cannot be lost that way.

The middleware returns **401 JSON** for `/api/*` rather than redirecting to
`/sign-in`. A redirect is worse than useless for an XHR: `fetch` and `axios`
follow it and resolve with a 200 HTML document, so the client reads a rejected
request as a successful one.

## `deleteMany` instead of `delete` for videos

`prisma.video.deleteMany({ where: { id, userId } })` does the ownership check
and the delete in one statement, so there is no read-then-write window. A row
that belongs to someone else comes back as `count: 0` and is reported as 404 —
403 would confirm that the id exists.

## Ownership migration adds the column in three steps

`prisma migrate diff` emits `ALTER TABLE "Video" ADD COLUMN "userId" TEXT NOT
NULL`, which aborts on a table that already has rows. The committed migration
adds the column nullable, tags existing rows `legacy-unknown-owner`, then sets
`NOT NULL`. Those rows keep their data and stop appearing in anybody's list,
which is the safe default when the real owner is unrecoverable.

## Tests use `node:test`, not a test framework

Node 24 ships a test runner, and `tsx` was already a dependency, so
`node --import tsx --test` runs TypeScript tests with no new tooling. The
suites cover the pure logic — validation rules, the rate-limit window, path
safety, and the sharp pipeline's output — because that is the part where a
regression is silent. There are no HTTP-level or browser tests.

## Not built

- **`ffmpeg` video pipeline.** Would remove the last hosted dependency, but
  transcoding does not belong in a request handler; it needs a job queue and a
  worker.
- **An application Docker image.** Next.js inlines `NEXT_PUBLIC_*` variables at
  build time, so a prebuilt image would need a Clerk publishable key baked in
  at `docker build` time. `docker-compose.yml` provides Postgres, which is the
  part that is genuinely awkward to set up by hand.
- **Object storage, shared-state rate limiting, background jobs, virus
  scanning, image dedup.** All reasonable next steps; none of them are here.
