/**
 * Removes a Video row whose Cloudinary asset is confirmed gone.
 *
 *   npm run forget-video -- <videoId> <publicId>            # report only
 *   npm run forget-video -- <videoId> <publicId> --delete   # remove the row
 *
 * The publicId is the check, not a convenience: read it off the row, confirm in
 * the Cloudinary console that the asset really is not there, and type it back.
 * A mismatch refuses.
 *
 * This exists because the delete route deliberately keeps the row when
 * Cloudinary will not confirm the destroy, and DECISIONS.md called clearing
 * such a row "an owner action" while providing no way to perform one. See
 * lib/forgetVideo.ts.
 *
 * Needs DATABASE_URL. The npm script passes --env-file-if-exists=.env for the
 * same reason `npm run reap` does: a bare tsx script does not load .env.
 */
import { forgetVideo } from "../lib/forgetVideo";
import { prismaVideoIndex } from "../lib/prismaMediaIndex";
import { prisma } from "../lib/prisma";

const USAGE =
  "usage: npm run forget-video -- <videoId> <publicId> [--delete]\n" +
  "       the publicId must match the row's own, so you have to look first";

async function main() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--delete");
  const dryRun = !process.argv.includes("--delete");
  const [id, confirmPublicId] = args;

  if (!id || !confirmPublicId) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const result = await forgetVideo({ index: prismaVideoIndex, id, confirmPublicId, dryRun });

  if (!result.ok && result.reason === "not-found") {
    console.error(`no Video row with id ${id}`);
    process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    console.error(
      `refused: row ${id} has publicId "${result.video.publicId}", not "${confirmPublicId}"`
    );
    process.exitCode = 1;
    return;
  }

  const { video } = result;
  console.log(`id:        ${video.id}`);
  console.log(`owner:     ${video.userId}`);
  console.log(`title:     ${video.title}`);
  console.log(`publicId:  ${video.publicId}`);
  console.log(`created:   ${video.createdAt.toISOString()}`);

  if (result.dryRun) {
    console.log("");
    console.log("nothing deleted. Re-run with --delete once you have confirmed in the");
    console.log("Cloudinary console that this asset is really gone -- this row is the");
    console.log("only handle the app has on it.");
    return;
  }

  console.log("");
  console.log(`deleted ${result.rowsRemoved} row(s)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
