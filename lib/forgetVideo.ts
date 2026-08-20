/**
 * The owner action for a video row whose Cloudinary asset really has gone.
 *
 * `DELETE /api/video-delete/:id` refuses to drop the row when Cloudinary
 * answers `"not found"`, because that string is not proof of absence: a destroy
 * against the wrong cloud, or against another account's credentials, answers it
 * for every id that exists. Dropping the row on that answer would throw away the
 * only handle the app has on an asset nothing confirmed destroyed. So the row is
 * kept and the caller gets a 502 (lib/handlers/videos.ts).
 *
 * DECISIONS.md and the delete handler both then said that clearing such a row
 * "is now an owner action" — and there was no owner action. No endpoint, no
 * script and no npm task removed a Video row without a successful destroy, and
 * VideoIndex had no un-scoped delete on it at all. "An owner action" meant
 * direct SQL, which is a different thing from a mechanism.
 *
 * This is the mechanism. It is a script rather than a route for the same reason
 * `npm run reap` is: deleting another account's row needs an administrator
 * identity and this app has none, so it inherits the shell's.
 *
 * The `publicId` is not a convenience — it is the check. The operator has to
 * read it off the row, go and look in the Cloudinary console, and type it back.
 * A mismatch refuses, so the command cannot be pointed at the wrong row by a
 * mistyped id, and it cannot be run by someone who never looked.
 */
import type { VideoIndex, VideoRecord } from "./mediaIndex";

export type ForgetVideoResult =
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "public-id-mismatch"; video: VideoRecord }
  | { ok: true; video: VideoRecord; rowsRemoved: number; dryRun: boolean };

export async function forgetVideo({
  index,
  id,
  confirmPublicId,
  dryRun = true,
}: {
  index: VideoIndex;
  id: string;
  /** Must equal the row's own publicId, read from the Cloudinary console. */
  confirmPublicId: string;
  dryRun?: boolean;
}): Promise<ForgetVideoResult> {
  const video = await index.findAny(id);
  if (!video) return { ok: false, reason: "not-found" };

  if (video.publicId !== confirmPublicId) {
    return { ok: false, reason: "public-id-mismatch", video };
  }

  // Dry run is the default, here and in the script, because this is the one
  // operation in the app that deletes the last handle on a remote asset. If the
  // operator is wrong about the asset being gone, it is gone from the app's
  // view and still being billed, and no sweep can find it again.
  if (dryRun) return { ok: true, video, rowsRemoved: 0, dryRun: true };

  const rowsRemoved = await index.deleteById(id);
  return { ok: true, video, rowsRemoved, dryRun: false };
}
