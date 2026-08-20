import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { REQUEST_ENVELOPE_ALLOWANCE, readLimitedFormData } from "../lib/requestLimits";

const BOUNDARY = "----limitstest";
const MAX_FILE = 1024 * 1024; // 1 MB, so the tests stay small and fast
const MAX_BODY = MAX_FILE + REQUEST_ENVELOPE_ALLOWANCE;

function multipartHead(): Buffer {
  return Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\n` +
      `Content-Type: image/png\r\n\r\n`
  );
}

function multipartTail(): Buffer {
  return Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
}

/**
 * A body that is produced lazily, so the test can see how much of it was
 * actually pulled before the meter cut it off.
 */
function streamingBody(totalChunks: number, chunkBytes: number) {
  const counter = { pulled: 0 };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(multipartHead());
    },
    pull(controller) {
      if (counter.pulled < totalChunks) {
        counter.pulled += 1;
        controller.enqueue(new Uint8Array(chunkBytes));
      } else {
        controller.enqueue(multipartTail());
        controller.close();
      }
    },
  });
  return { stream, counter };
}

function streamedRequest(stream: ReadableStream<Uint8Array>, contentLength?: number): Request {
  const headers: Record<string, string> = {
    "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
  };
  if (contentLength !== undefined) headers["content-length"] = String(contentLength);
  return new Request("http://localhost/api/image-upload", {
    method: "POST",
    headers,
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("readLimitedFormData: the declared length", () => {
  it("rejects an over-sized Content-Length without touching the body", async () => {
    let bodyWasRead = false;
    const request = new NextRequest("http://localhost/api/image-upload", {
      method: "POST",
      headers: { "content-length": String(250 * 1024 * 1024) },
    });
    // If the implementation reaches for the body at all, this trips.
    Object.defineProperty(request, "body", {
      get() {
        bodyWasRead = true;
        return null;
      },
    });

    const result = await readLimitedFormData(request, MAX_FILE);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 413);
    assert.match(result.error, /Request body is too large/);
    assert.equal(bodyWasRead, false, "the 250 MB body must never be read");
  });

  it("allows a Content-Length inside the limit", async () => {
    const { stream } = streamingBody(1, 1024);
    const result = await readLimitedFormData(streamedRequest(stream, 4096), MAX_FILE);
    assert.equal(result.ok, true);
  });
});

describe("readLimitedFormData: the body itself", () => {
  it("aborts a chunked body that lies about its size, part-way through", async () => {
    // No Content-Length at all -- the header gate cannot fire, so this is
    // entirely the meter's job.
    const chunk = 256 * 1024;
    const chunks = 40; // 10 MB offered against a 2 MB ceiling
    const { stream, counter } = streamingBody(chunks, chunk);

    const result = await readLimitedFormData(streamedRequest(stream), MAX_FILE);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 413);

    const pulledBytes = counter.pulled * chunk;
    assert.ok(
      pulledBytes <= MAX_BODY + chunk,
      `read ${pulledBytes} bytes of a ${chunks * chunk}-byte body; ceiling is ${MAX_BODY}`
    );
    assert.ok(counter.pulled < chunks, "it must not have drained the whole body");
  });

  it("aborts even when Content-Length claims the body is small", async () => {
    const chunk = 256 * 1024;
    const { stream, counter } = streamingBody(40, chunk);

    const result = await readLimitedFormData(streamedRequest(stream, 1024), MAX_FILE);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 413);
    assert.ok(counter.pulled < 40);
  });

  it("passes a body inside the limit through unchanged", async () => {
    const payload = new Uint8Array(64 * 1024).fill(7);
    const form = new FormData();
    form.append("file", new File([payload], "a.png", { type: "image/png" }));
    form.append("title", "kept");
    const request = new NextRequest("http://localhost/api/video-upload", {
      method: "POST",
      body: form,
    });

    const result = await readLimitedFormData(request, MAX_FILE);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const file = result.formData.get("file") as File;
    assert.equal(file.size, payload.length);
    assert.equal(result.formData.get("title"), "kept");
  });

  it("reports malformed multipart as 400, not as too large", async () => {
    const request = new Request("http://localhost/api/image-upload", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("this is not multipart at all"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const result = await readLimitedFormData(request, MAX_FILE);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, 400);
  });
});
