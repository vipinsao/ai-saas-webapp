import Image from "next/image";
import Link from "next/link";

/**
 * The public landing page.
 *
 * This route was the untouched `create-next-app` template -- the Next.js logo,
 * "Get started by editing app/page.tsx", and links to Vercel. It was also
 * unreachable: the middleware sent "/" to /home when signed in and to /sign-in
 * when not, so a visitor met a Clerk login box with nothing explaining what the
 * app was for, and nobody ever saw that the page was still boilerplate.
 *
 * "/" is a public route now, so this is what a signed-out visitor lands on.
 * Everything claimed below is something the code in this repo does.
 */
export const metadata = {
  title: "Social Share — crop images for social media, compress video",
  description:
    "Upload an image and crop it to the social-media aspect ratios, or upload a video and get a compressed copy. Images are processed locally with sharp.",
};

const features = [
  {
    title: "Images are processed on this server",
    body: "sharp decodes the upload, applies its EXIF orientation, strips the rest of the metadata (GPS included) and re-encodes to WebP. No media API is involved and no account is needed for this half.",
  },
  {
    title: "Five crops, computed on request",
    body: "Instagram square and portrait, Twitter post and header, Facebook cover. Each one is cropped when you ask for it, using the highest-detail region rather than the centre, so a subject near an edge survives the crop.",
  },
  {
    title: "Video compression through Cloudinary",
    body: "A video upload is transcoded by Cloudinary and the before and after sizes are recorded. This half needs a Cloudinary account; without one the app says so plainly and the image half keeps working.",
  },
  {
    title: "Your uploads are yours",
    body: "Every file is scoped to the account that uploaded it, listed only for that account, and kept until it is deleted — within a per-account storage limit.",
  },
];

export default function LandingPage() {
  return (
    <main className="min-h-screen px-6 py-16">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Social Share</h1>

        <p className="mt-4 text-lg opacity-80">
          Upload an image and get it cropped to the aspect ratios the social
          networks ask for. Upload a video and get a compressed copy back.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/sign-in" className="btn btn-primary">
            Sign in
          </Link>
          <Link href="/sign-up" className="btn btn-outline">
            Create an account
          </Link>
        </div>

        <figure className="mt-12">
          <Image
            src="/screenshots/video-library.png"
            alt="The video library: one card showing a thumbnail, the title, the original and compressed sizes, and the compression saved."
            width={1915}
            height={858}
            priority
            className="rounded-lg border border-base-300 w-full h-auto"
          />
          <figcaption className="mt-2 text-xs opacity-60">
            The video library after an upload. Screenshot taken before the
            controls on each card were reworked, so the buttons look slightly
            different today.
          </figcaption>
        </figure>

        <dl className="mt-12 grid gap-6 sm:grid-cols-2">
          {features.map((feature) => (
            <div key={feature.title}>
              <dt className="font-semibold">{feature.title}</dt>
              <dd className="mt-1 text-sm opacity-80">{feature.body}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-12 text-xs opacity-60">
          A portfolio project, built with Next.js, Clerk, Prisma and sharp.
          Source:{" "}
          <a
            className="link"
            href="https://github.com/vipinsao/ai-saas-webapp"
            target="_blank"
            rel="noopener noreferrer"
          >
            github.com/vipinsao/ai-saas-webapp
          </a>
        </p>
      </div>
    </main>
  );
}
