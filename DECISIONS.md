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
demo use. If you do not want a Cloudinary account at all, leave the Cloudinary variables
blank: the image features work, and both video routes answer 503 naming the
variables that are missing.

**No Cloudinary account was used while writing or testing the current code.**
See "What the video tests do not prove" below.

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

## Deletes are ordered so the leftover is always the recoverable one

A delete touches two stores that cannot be updated in one transaction: a row in
Postgres and a file (local, or in Cloudinary). Whichever order you pick, a crash
in between leaves one of them behind. The choice is not *whether* to leak, it is
*which leak you want*, and the answer is different for the two media types.

**Images: row first, then file.**

The two half-states are:

- *file with no row* — invisible. It is not in any listing, it is not counted
  against the quota, and the transform route refuses to serve it because that
  route looks the row up before it reads the disk. It costs disk space and
  nothing else, and it is recoverable: the store can be walked, so a sweep can
  find it and remove it.
- *row with no file* — visible damage. The image is in the user's list, it is
  charged to their quota, and opening it 404s.

Only the first is harmless, so the delete is ordered to produce the first.

**Videos: remote asset first, then row.**

Here the same reasoning gives the opposite answer, because the recoverability
argument reverses. `publicId` is the only handle this app has on a Cloudinary
asset, and it exists in exactly one place: the row. Delete the row first and
crash, and nothing left in the app can name the asset — it sits in the account
being billed, for ever, and no sweep can find it because the app cannot
enumerate a Cloudinary folder from a request handler. So the row goes last, and
if the remote delete fails the row is deliberately kept and a 502 is returned
rather than a success.

The cost is the residue this order produces: a row pointing at an asset that has
gone, which shows as a broken thumbnail. That one is self-healing — pressing
delete again re-runs `destroy`, which answers `{ result: "not found" }` for an
asset that is already gone, and the row is then removed.

The rule underneath both: **delete last the thing that lets you find the
others.** The filesystem is enumerable, so an image row is expendable. A remote
asset is not enumerable from here, so its row is not.

Writes follow the same logic in reverse — file/asset first, row second — so
that a failed write leaks in the same direction the reaper already sweeps. Both
upload handlers also compensate explicitly: if the row cannot be written, the
bytes that were just stored are removed again before the 500 goes out.

## Uploaded images are indexed, which is what makes a delete possible at all

Images used to be written to disk and recorded nowhere. The upload returned an
id, the browser held it in React state, and a page reload lost it. There was no
listing, no delete endpoint, and no way for a user to name a file they had
uploaded five minutes earlier — so **every file ever uploaded stayed on disk for
ever**. That is the mechanism behind "files accumulate for ever"; a missing
DELETE route was the symptom, not the cause.

`prisma/migrations/20260820120000_image_index` adds an `Image` table whose
primary key is the same 32-hex value as the filename. It buys three things at
once: a listing, an owner-scoped delete, and a `SUM(bytes)` that a quota can be
enforced against. The cost is that the image half now needs Postgres, where
before it needed only a writable directory.

## `npm run reap` is a script, not an endpoint

The reaper deletes other people's files. An HTTP route that does that needs an
administrator identity, and this app has no notion of one — Clerk gives it
end users and nothing else. Inventing an admin role, or guarding the route with
a shared secret in an environment variable, would both be more attack surface
than the job is worth. A script inherits the authority of the shell that runs
it, which is the correct authority for a maintenance job, and it is scheduled
the way maintenance jobs are normally scheduled.

It leaves files younger than 15 minutes alone. An upload writes the file before
it writes the row, so there is a window in which a healthy file legitimately has
no row; without the grace period the sweep would race live uploads and delete
the bytes out from under them. Fifteen minutes is far longer than any request
here and far shorter than "for ever".

## The quota answers 507, not 413

413 Payload Too Large means "this request was too big; send a smaller one". When
an account is out of storage that is misleading twice over: the request may be
tiny and still fail, and no smaller request will succeed until something is
deleted. 507 Insufficient Storage says the store is full, which is both true and
actionable, and it lets the page tell the user to delete an image rather than to
try again with a smaller file.

The check runs against the *encoded* size, after `sharp` has produced the WebP,
rather than against the uploaded size. Checking the uploaded size would be
cheaper but would reject files that would have fitted, because WebP is usually a
good deal smaller than the original. The wasted work is bounded by the 10 MB
per-file cap and the rate limiter.

The quota counts the local image store only. Video bytes live in Cloudinary and
are governed by that account's plan, which this app cannot read from a request
handler. Adding a video quota would also mean migrating `originalSize` and
`compressedSize` from `String` to an integer type before they could be summed;
that migration is not worth it for a number Cloudinary already enforces.

## Route handlers are factories that take their dependencies

Each handler lives in `lib/handlers/` as `createXHandler(deps)`, and each
`route.ts` is one line that passes in the real Clerk session, the real Prisma
index and the real Cloudinary client.

This is what makes the handlers testable at all. A `route.ts` that imports
`@clerk/nextjs/server` and `@/lib/prisma` at module scope cannot be loaded by a
test runner without a Clerk request context and a database connection. With the
dependencies as arguments, `tests/imageHandlers.test.ts` and
`tests/videoHandlers.test.ts` call the same functions the routes export, with an
in-memory index and a temp directory, and assert the real status codes, the real
JSON bodies and the real ordering of writes.

The alternative was `mock.module`, which in Node 24 still needs
`--experimental-test-module-mocks`. Passing dependencies in is not experimental.

## What the video tests do not prove

**No live Cloudinary account was used at any point.** The video path is covered
by `tests/videoHandlers.test.ts`, which drives the real upload and delete
handlers against a fake client. That establishes:

- the file is sent to the `video-uploads` folder, once;
- `originalSize` is measured from the bytes the server received and
  `compressedSize` is taken from Cloudinary's answer — neither is read from the
  form, as one of them used to be;
- the row is stamped with the session's user id, and a `userId` field smuggled
  into the form body is ignored;
- a missing or blank title is a 400 rather than a Prisma NOT NULL error;
- missing configuration is a 503 naming the variables, before the body is read;
- 401/403, 400, 420/429 and network failures each map to their own status and
  message;
- if the row cannot be written, the uploaded asset is destroyed rather than
  leaked;
- delete destroys the remote asset before the row, keeps the row if that fails,
  and completes when Cloudinary reports the asset was already gone.

It does **not** establish that the real SDK behaves the way the fake does.
The `type: "authenticated"` change widens this: that uploads are stored as
authenticated, that the signed URLs this code generates are accepted for
delivery, and that `destroy` with `type: "authenticated"` finds them, are all
unverified against the live service.
Specifically unverified against the live service: that `upload_stream` with
`resource_type: "video"` and `quality: auto, fetch_format: mp4` returns the
`public_id`, `bytes` and `duration` fields the code reads; that a rejected
credential really arrives as `{ http_code: 401 }` (this is taken from the SDK's
own `UploadApiErrorResponse` type, not from an observed response); that
`uploader.destroy(publicId, { resource_type: "video" })` answers
`{ result: "ok" }` and `{ result: "not found" }`; and that the `fl_attachment`
download URL and the `e_preview` thumbnail URL resolve. Anyone with an account
can check all of it in about ten minutes; nobody has.

## The landing page exists because the app had no front door

`app/page.tsx` was the untouched `create-next-app` template, and the middleware
redirected "/" to `/sign-in` for signed-out visitors, so nobody ever saw it and
nothing revealed that it was still boilerplate. From the outside the project was
a Clerk login box with no explanation of what it was for.

"/" is now public and renders a page that says what the app does, with a
screenshot of the video library. Signed-in visitors are still redirected to
`/home`, so it never appears mid-session. Everything the page claims is
something the code in this repo does.

## Deleting a video is a two-step confirmation, not a `confirm()`

The delete control was a 24px icon whose only label was a `title` attribute —
never shown on a touch device — and one tap destroyed a video with no
confirmation. `window.confirm` would have been one line, but it is suppressed in
some embedded contexts and cannot be styled or tested. The card switches to an
inline "Delete this video? Cancel / Yes, delete" row instead, which is ordinary
React state.

The download control moved from a JavaScript `<a download>` to a plain link
carrying Cloudinary's `fl_attachment` flag. `download` is ignored by every
browser on a cross-origin URL, so the old button just navigated to
res.cloudinary.com and played the video in a tab; `fl_attachment` makes
Cloudinary send `Content-Disposition: attachment`, which works because the
decision is made server-side.

## One `.env`, and placeholder Clerk keys that are the right shape

The setup instructions said `cp .env.example .env.local`, and that sequence
does not work. Next.js reads `.env.local` and `.env`; the Prisma CLI reads only
`.env`. So the app built, and the very next command in the README --
`npx prisma migrate deploy` -- failed with
`P1012 ... Environment variable not found: DATABASE_URL`, for everybody. The
alternatives were a `dotenv-cli` wrapper around every Prisma script or telling
people to keep two copies of the same file in sync. Using the one file both
tools already read is smaller than either.

`.env.example` also shipped `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_..."`,
which is not a key shape Clerk can parse. Clerk throws on it, and because
`next build` prerenders pages that mount `ClerkProvider`, the *build* failed --
not just the requests. It now ships the same syntactically valid placeholder CI
uses (base64 of `example.clerk.accounts.dev$`), so a fresh clone builds, starts,
and serves the public landing page with no account anywhere.

What was deliberately not built: a `DISABLE_AUTH=1` bypass. It would let a
reviewer click through the signed-in pages without a Clerk account, and it is
a code path whose entire purpose is to switch authentication off. Shipping one
is how it ends up enabled somewhere it should not be. The placeholder key gets
a stranger to a working landing page and a green test suite without that risk,
and a real Clerk key is free and takes two minutes.

## The reaper's two sides are not symmetrical, and the first version got it backwards

Deleting an orphan file costs one image, and the file side was written
carefully: a grace window, a skip counter, and a scan that only returns files it
can prove it named. Deleting orphan rows costs the index, and that side had no
grace window and no sanity check at all.

`listStoredImages` answers `[]` when the root does not exist, because an empty
store genuinely is not a crash. `reapOrphans` then built its set of "files that
exist" from that empty list, and every row in the table matched "row whose file
is gone". Reproduced with five rows and a missing directory: five orphan rows
reported, zero rows left.

The default root is `process.cwd()/storage/uploads`. An ephemeral filesystem, a
fresh deploy, an unset `IMAGE_STORAGE_DIR`, or a cron entry that starts the
process from the wrong directory all produce that ENOENT. This was one bad
cron line away from destroying every user's index.

The guards are deliberately blunt, because the asymmetry of the outcomes is
blunt. A sweep that refuses to run is an alert somebody reads in the morning; a
sweep that runs on a bad scan is a restore from backup. So: the root must exist
and be a directory; zero files with rows present is treated as a broken mount
rather than a table full of orphans; and rows get the same grace window files
get. The refusal also fires on `--dry-run`, because a dry run reporting "would
delete 5 rows" would be read as a finding about the data when it is a finding
about the mount.

Rows are read before the directory is scanned, too. An upload writes its file
then its row, so reading rows first guarantees every row considered had its file
written before the scan began — closing the quieter version of the same bug,
where an upload landing mid-sweep looked like a row with no file.

## The format is decided by the bytes, because decoding is the attack

`validateUpload` filters on the `Content-Type` the browser sent, and the comment
next to it used to say the pipeline "re-checks the real format by decoding the
bytes with sharp". That is precisely backwards. Measured with the real
validator and the verbatim sharp call:

    payload: 119 bytes of SVG, sent as Content-Type: image/png
    validateUpload -> { ok: true }
    sharp ACCEPTED -> 8000x8000, 4967 ms

`MAX_IMAGE_BYTES` does not help, and the reason is worth stating plainly: it
bounds the *compressed* input, and the cost lives in the *decoded* pixels. The
entire point of a decode bomb is that those two numbers are unrelated. A 10 MB
cap on a format that can express "one billion pixels" in one line of text is
not a limit on anything.

So `lib/imageSniff.ts` settles the format from a signature before any decoder
runs. It is an allowlist of binary signatures rather than a denylist of known
bombs, and that is what makes it hold against the class instead of the
instance: SVG is text and has no signature, so it cannot be on the list, and
neither can markup, an archive, or a document, whatever header it arrives with.

The decoder is bounded anyway — `limitInputPixels: 50_000_000` (sharp's own
default is 268 MP), a 10-second pipeline timeout, and a 4096px cap on the
stored image. Not belt-and-braces: an allowlist is a list, lists get edited, and
the day somebody adds a format the pixel limit is what is left.

The stored-image cap is a real behaviour change. A 6000x3000 upload is stored at
4096x2048. No preset is above 1500px so nothing displayed changes; what changes
is that a huge source is not re-decoded on every crop.

## Request bodies are metered, not measured afterwards

`await request.formData()` reads the entire body into memory, and the App Router
puts no ceiling on it — Next's `bodySizeLimit` applies to Server Actions only.
Every size rule in this app ran on `file.size`, which is knowable only after
that has already happened. A 250 MB body was parsed in full, at about a
gigabyte of RSS, and then rejected for being too large.

Two gates, because either alone is bypassable. `Content-Length` is checked
before the body is touched — cheap, and enough for honest clients. The stream is
then metered regardless, and aborted the moment it passes the ceiling, which
covers `Transfer-Encoding: chunked` and a client that lies in the header.

What this does not do is make a large upload cheap. A legitimate 200 MB video
still costs ~200 MB of RSS, because `formData()` materialises it. That is the
single-buffered-request design, and it is listed as a limitation. The change is
that the ceiling is the configured limit rather than whatever the caller sends.

## Video assets are authenticated, and the browser is not trusted to build URLs

Uploads passed `resource_type: "video"` and nothing else, so they took
Cloudinary's default `type: "upload"`: public delivery. A `publicId` was, on its
own, a working download link from anywhere, with no session and no signature.
The client was handed that id and built its own delivery URLs from it — which
only works at all *because* no secret was required.

Two things follow, and only one of them is fixable in code.

Fixable: uploads now use `type: "authenticated"`, `GET /api/videos` mints signed
URLs per request for the caller's own rows, and `publicId` is not in the
response. `destroyVideo` had to learn the same `type`, because a destroy whose
type does not match the upload answers `{ result: "not found" }` and leaves the
asset in place — a delete that reports success and deletes nothing, which is the
exact failure the delete ordering was written to prevent.

Not fixable: adding `where: { userId }` to the list query stopped new
disclosure and revoked nothing. While that query was unscoped, every account
received every other account's `publicId`, and those URLs still resolve. The
remedy is to destroy and re-upload the affected assets, which is an owner
action and is written down as one in the README.

What is *not* claimed: that a signed URL hides the public id. It cannot — the id
is a path segment. The property that matters is that holding it now buys
nothing without a signature this server alone can compute. The tests assert that
property (authenticated path, signature segment, signature changes with the
secret) rather than the theatre.

Signature generation is a local HMAC, so all of that is verifiable here.
Whether Cloudinary *accepts* the signatures is not, and it widens the list
below.

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
- **A scheduler for the reaper.** `npm run reap` has to be put in cron by hand.
- **Streaming multipart parsing.** The body is metered and aborted past the
  limit, but a body inside the limit is still materialised in memory.
- **Anything for video content.** Videos are not sniffed the way images are;
  the declared type is the only filter, and the bytes go to Cloudinary, which
  rejects what it cannot process. The cost of a bad video file is Cloudinary's,
  not this server's, which is why the image side got the work.
- **Any verification against live Cloudinary.** See above.
