/**
 * Bounds how many bytes a route handler will read before it decides.
 *
 * `await request.formData()` buffers the entire body into memory, and the App
 * Router puts no cap on it: Next's `bodySizeLimit` applies to Server Actions
 * only. So the 10 MB image rule and the 200 MB video rule in
 * uploadValidation.ts were accounting rather than controls -- they ran on
 * `file.size`, which is only knowable once the whole body is already in memory.
 * A 250 MB body was parsed in full, at about 1 GB of RSS, and only then
 * rejected for being too large.
 *
 * Two gates, because either alone is bypassable:
 *
 *   1. `Content-Length`, when the client sends one, is checked before the body
 *      is touched at all. This is the cheap path and covers honest clients.
 *   2. The body stream is then metered regardless, and aborted the moment it
 *      passes the cap. This covers `Transfer-Encoding: chunked`, and a client
 *      that simply lies in the header.
 *
 * What this does NOT do is make a large upload cheap. A legitimate 200 MB video
 * still costs 200 MB of RSS, because `formData()` materialises it; that is a
 * property of the design and is written down in the README. What changes is
 * that the ceiling is now the configured limit instead of whatever the caller
 * decides to send.
 */

/**
 * Multipart overhead the file itself does not account for: the boundary lines,
 * the per-part headers, and the title/description fields on the video form.
 * Generous on purpose -- the exact per-file limit is still enforced afterwards
 * by validateUpload, so this only has to be too small to matter, not precise.
 */
export const REQUEST_ENVELOPE_ALLOWANCE = 1024 * 1024;

/** Sentinel so an over-limit abort is told apart from a genuine parse error. */
const OVER_LIMIT = "__UPLOAD_BODY_OVER_LIMIT__";

export type LimitedFormData =
  | { ok: true; formData: FormData }
  | { ok: false; status: 413 | 400; error: string };

function tooLarge(maxBodyBytes: number): LimitedFormData {
  return {
    ok: false,
    status: 413,
    error: `Request body is too large. The limit is ${Math.floor(maxBodyBytes / (1024 * 1024))} MB.`,
  };
}

export async function readLimitedFormData(
  request: Request,
  maxFileBytes: number
): Promise<LimitedFormData> {
  const maxBodyBytes = maxFileBytes + REQUEST_ENVELOPE_ALLOWANCE;

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBodyBytes) {
    // Nothing has been read yet, and nothing will be.
    return tooLarge(maxBodyBytes);
  }

  if (!request.body) {
    // No stream to meter (an already-materialised body). The header check above
    // is all there is, and validateUpload still enforces the per-file limit.
    try {
      return { ok: true, formData: await request.formData() };
    } catch {
      return { ok: false, status: 400, error: "Malformed upload" };
    }
  }

  let bytesRead = 0;
  const metered = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytesRead += chunk.byteLength;
        if (bytesRead > maxBodyBytes) controller.error(new Error(OVER_LIMIT));
        else controller.enqueue(chunk);
      },
    })
  );

  // The headers are carried over so the multipart boundary survives;
  // content-length is dropped because the metered stream is re-sent chunked.
  const headers = new Headers(request.headers);
  headers.delete("content-length");

  try {
    const metredRequest = new Request(request.url, {
      method: "POST",
      headers,
      body: metered,
      // Required by undici whenever the body is a stream.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    return { ok: true, formData: await metredRequest.formData() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes(OVER_LIMIT)) return tooLarge(maxBodyBytes);
    return { ok: false, status: 400, error: "Malformed upload" };
  }
}
