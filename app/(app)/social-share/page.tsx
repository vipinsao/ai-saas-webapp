"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  SOCIAL_FORMATS,
  SOCIAL_FORMAT_IDS,
  type SocialFormatId,
} from "@/lib/socialFormats";
import { MAX_IMAGE_BYTES, formatBytes, IMAGE_MIME_TYPES } from "@/lib/uploadValidation";

interface StoredImage {
  id: string;
  width: number;
  height: number;
  bytes: number;
  originalBytes: number;
  createdAt: string;
}

interface Usage {
  usedBytes: number;
  quotaBytes: number;
  remainingBytes: number;
}

export default function SocialShare() {
  const [images, setImages] = useState<StoredImage[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [selected, setSelected] = useState<StoredImage | null>(null);
  const [selectedFormat, setSelectedFormat] =
    useState<SocialFormatId>("instagram-square");
  const [isUploading, setIsUploading] = useState(false);
  const [isTransforming, setIsTransforming] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const previewUrl = useMemo(
    () => (selected ? `/api/images/${selected.id}?format=${selectedFormat}` : null),
    [selected, selectedFormat]
  );

  // Each format change requests a fresh crop from the server, so show the
  // spinner until that specific response has painted.
  useEffect(() => {
    if (previewUrl) setIsTransforming(true);
  }, [previewUrl]);

  /**
   * Uploads used to be write-only: the id lived in React state and was lost on
   * reload, so a file could never be found again -- or deleted. This is the
   * read side of that.
   */
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/images");
      if (!response.ok) throw new Error(`Could not load your images (${response.status})`);
      const body = await response.json();
      setImages(body.images as StoredImage[]);
      setUsage(body.usage as Usage);
    } catch (cause) {
      console.error(cause);
      setError(cause instanceof Error ? cause.message : "Could not load your images");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setIsUploading(true);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("/api/image-upload", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        // Every failure path on the route returns { error }, so surface the
        // specific reason -- including the quota one, which tells the user to
        // delete something rather than to try a smaller file.
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `Upload failed (${response.status})`);
      }

      const uploaded = (await response.json()) as StoredImage;
      setSelected(uploaded);
      await refresh();
    } catch (cause) {
      console.error(cause);
      setError(cause instanceof Error ? cause.message : "Upload failed");
    } finally {
      setIsUploading(false);
      // Let the same file be chosen again after a failure.
      event.target.value = "";
    }
  };

  const handleDelete = async (id: string) => {
    setError(null);
    setDeletingId(id);
    try {
      const response = await fetch(`/api/images/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `Delete failed (${response.status})`);
      }
      if (selected?.id === id) setSelected(null);
      await refresh();
    } catch (cause) {
      console.error(cause);
      setError(cause instanceof Error ? cause.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  };

  const savedPercentage =
    selected && selected.originalBytes > 0
      ? Math.round((1 - selected.bytes / selected.originalBytes) * 100)
      : null;

  const usedPercentage = usage
    ? Math.min(100, Math.round((usage.usedBytes / usage.quotaBytes) * 100))
    : 0;

  return (
    <div className="container mx-auto p-4 max-w-4xl">
      <h1 className="text-3xl font-bold mb-2 text-center">
        Social Media Image Creator
      </h1>
      <p className="text-center text-sm opacity-70 mb-6">
        Cropped and compressed locally with sharp. Nothing is sent to a media API.
      </p>

      <div className="card">
        <div className="card-body">
          <h2 className="card-title mb-4">Upload an Image</h2>

          {error && (
            <div role="alert" className="alert alert-error mb-4">
              <span>{error}</span>
            </div>
          )}

          <div className="form-control">
            <label className="label" htmlFor="image-file">
              <span className="label-text">
                Choose an image file (max {formatBytes(MAX_IMAGE_BYTES)})
              </span>
            </label>
            <input
              id="image-file"
              type="file"
              accept={IMAGE_MIME_TYPES.join(",")}
              disabled={isUploading}
              onChange={handleFileUpload}
              className="file-input file-input-bordered file-input-primary w-full"
            />
          </div>

          {usage && (
            <div className="mt-4">
              <div className="flex justify-between text-sm opacity-70">
                <span>Storage used</span>
                <span>
                  {formatBytes(usage.usedBytes)} of {formatBytes(usage.quotaBytes)}
                </span>
              </div>
              <progress
                className="progress progress-primary w-full"
                value={usedPercentage}
                max={100}
                aria-label="Storage used"
              />
            </div>
          )}

          {isUploading && (
            <div className="mt-4 flex items-center gap-3">
              <span className="loading loading-spinner" />
              <span className="text-sm">Uploading and re-encoding…</span>
            </div>
          )}

          {selected && previewUrl && (
            <div className="mt-6">
              <h2 className="card-title mb-4">Select Social Media Format</h2>
              <div className="form-control">
                <select
                  aria-label="Social media format"
                  className="select select-bordered w-full"
                  value={selectedFormat}
                  onChange={(event) =>
                    setSelectedFormat(event.target.value as SocialFormatId)
                  }
                >
                  {SOCIAL_FORMAT_IDS.map((id) => (
                    <option key={id} value={id}>
                      {SOCIAL_FORMATS[id].label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="mt-6 relative">
                <h3 className="text-lg font-semibold mb-2">
                  Preview: {SOCIAL_FORMATS[selectedFormat].width}×
                  {SOCIAL_FORMATS[selectedFormat].height}
                </h3>
                <div className="flex justify-center">
                  {isTransforming && (
                    <div className="absolute inset-0 flex items-center justify-center bg-base-100 bg-opacity-50 z-10">
                      <span className="loading loading-spinner loading-lg" />
                    </div>
                  )}
                  {/* The API already returns a correctly sized, private WebP, so
                      next/image would only add a second optimisation hop. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    key={previewUrl}
                    src={previewUrl}
                    alt={`Preview cropped to ${SOCIAL_FORMATS[selectedFormat].label}`}
                    className="max-w-full h-auto"
                    onLoad={() => setIsTransforming(false)}
                    onError={() => {
                      setIsTransforming(false);
                      setError("The preview could not be generated. Try uploading again.");
                    }}
                  />
                </div>
              </div>

              <p className="mt-4 text-sm opacity-70">
                Stored copy: {selected.width}×{selected.height},{" "}
                {formatBytes(selected.bytes)}
                {savedPercentage !== null && savedPercentage > 0
                  ? ` (${savedPercentage}% smaller than the original)`
                  : ""}
              </p>

              <div className="card-actions justify-end mt-6">
                <a
                  className="btn btn-primary"
                  href={`${previewUrl}&download=1`}
                  download
                >
                  Download for {SOCIAL_FORMATS[selectedFormat].label}
                </a>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="card mt-8">
        <div className="card-body">
          <h2 className="card-title mb-4">Your uploads ({images.length})</h2>

          {images.length === 0 ? (
            <p className="text-sm opacity-70">
              Nothing stored yet. Uploads stay until you delete them.
            </p>
          ) : (
            <ul className="divide-y divide-base-300">
              {images.map((image) => (
                <li
                  key={image.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-3"
                >
                  <div className="text-sm">
                    <div className="font-mono">{image.id.slice(0, 12)}…</div>
                    <div className="opacity-70">
                      {image.width}×{image.height}, {formatBytes(image.bytes)}, uploaded{" "}
                      {new Date(image.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setSelected(image)}
                      disabled={selected?.id === image.id}
                    >
                      {selected?.id === image.id ? "Selected" : "Preview"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-error"
                      onClick={() => handleDelete(image.id)}
                      disabled={deletingId === image.id}
                    >
                      {deletingId === image.id ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
