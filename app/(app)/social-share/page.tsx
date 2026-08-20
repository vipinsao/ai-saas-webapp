"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  SOCIAL_FORMATS,
  SOCIAL_FORMAT_IDS,
  type SocialFormatId,
} from "@/lib/socialFormats";
import { MAX_IMAGE_BYTES, formatBytes, IMAGE_MIME_TYPES } from "@/lib/uploadValidation";

interface UploadedImage {
  id: string;
  width: number;
  height: number;
  bytes: number;
  originalBytes: number;
}

export default function SocialShare() {
  const [uploaded, setUploaded] = useState<UploadedImage | null>(null);
  const [selectedFormat, setSelectedFormat] =
    useState<SocialFormatId>("instagram-square");
  const [isUploading, setIsUploading] = useState(false);
  const [isTransforming, setIsTransforming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewUrl = useMemo(
    () => (uploaded ? `/api/images/${uploaded.id}?format=${selectedFormat}` : null),
    [uploaded, selectedFormat]
  );

  // Each format change requests a fresh crop from the server, so show the
  // spinner until that specific response has painted.
  useEffect(() => {
    if (previewUrl) setIsTransforming(true);
  }, [previewUrl]);

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
        // specific reason instead of a generic "upload failed".
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `Upload failed (${response.status})`);
      }

      setUploaded((await response.json()) as UploadedImage);
    } catch (cause) {
      console.error(cause);
      setUploaded(null);
      setError(cause instanceof Error ? cause.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  };

  const savedPercentage =
    uploaded && uploaded.originalBytes > 0
      ? Math.round((1 - uploaded.bytes / uploaded.originalBytes) * 100)
      : null;

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

          {isUploading && (
            <div className="mt-4 flex items-center gap-3">
              <span className="loading loading-spinner" />
              <span className="text-sm">Uploading and re-encoding…</span>
            </div>
          )}

          {uploaded && previewUrl && (
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
                Stored copy: {uploaded.width}×{uploaded.height},{" "}
                {formatBytes(uploaded.bytes)}
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
    </div>
  );
}
