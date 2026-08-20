/**
 * Reconciles the image store against the Image table.
 *
 *   npm run reap -- --dry-run     # report only
 *   npm run reap                  # report and delete
 *
 * Meant for a cron entry (hourly is plenty). It is a script rather than an HTTP
 * route on purpose: an endpoint that deletes other people's files needs an
 * administrator identity, and this app has no notion of one. A script inherits
 * the shell's authority, which is the correct authority for a maintenance job.
 *
 * Needs DATABASE_URL, and IMAGE_STORAGE_DIR if the store is not the default.
 * Both come from .env, the file the README's setup step creates. `npm run dev`
 * and `npm run build` get that for free because Next.js loads .env itself; a
 * bare tsx script does not, so the npm script passes --env-file-if-exists=.env.
 * Without it, following the documented setup and then running this command
 * fails with "Environment variable not found: DATABASE_URL". A real environment
 * variable still wins -- the flag does not overwrite what is already set, and
 * the "if-exists" form keeps the command working with no .env at all.
 */
import { defaultStorageRoot } from "../lib/imageStore";
import { prismaImageIndex } from "../lib/prismaMediaIndex";
import { reapOrphans, UntrustworthyScanError } from "../lib/reaper";
import { prisma } from "../lib/prisma";

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const root = defaultStorageRoot();

  const report = await reapOrphans({ index: prismaImageIndex, root, dryRun });

  console.log(`store:      ${root}`);
  console.log(`scanned:    ${report.scannedFiles} files, ${report.scannedRows} rows`);
  console.log(
    `too new:    ${report.skippedFilesTooNew} file(s) and ${report.skippedRowsTooNew} row(s) ` +
      `inside the grace window, left alone`
  );
  console.log(
    `files with no row: ${report.orphanFiles.length}` +
      (dryRun ? " (not deleted)" : ` deleted, ${megabytes(report.bytesReclaimed)} reclaimed`)
  );
  for (const orphan of report.orphanFiles) {
    console.log(`  - ${orphan.ownerId}/${orphan.imageId} (${megabytes(orphan.bytes)})`);
  }
  console.log(
    `rows with no file: ${report.orphanRows.length}` + (dryRun ? " (not deleted)" : " deleted")
  );
  for (const orphan of report.orphanRows) {
    console.log(`  - ${orphan.userId}/${orphan.id}`);
  }
}

main()
  .catch((error) => {
    // UntrustworthyScanError is the guard doing its job, not a crash: say so
    // in one line rather than burying it in a stack trace.
    if (error instanceof UntrustworthyScanError) console.error(error.message);
    else console.error(error);
    // Non-zero so a cron wrapper or CI step notices.
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
