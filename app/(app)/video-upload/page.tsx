"use client";
import React, { useState } from "react";
import axios from "axios";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { MAX_VIDEO_BYTES, formatBytes } from "@/lib/uploadValidation";

function VideoUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    if (file.size > MAX_VIDEO_BYTES) {
      // The message used to say 5MB while the constant allowed 200MB. Both now
      // come from the same constant the server validates against.
      toast.error(`File is too large. Maximum size is ${formatBytes(MAX_VIDEO_BYTES)}.`, {
        position: "top-right",
        autoClose: 5000,
      });
      return;
    }

    setIsUploading(true);
    setProgress(0);
    const formdata = new FormData();
    formdata.append("file", file);
    formdata.append("title", title);
    formdata.append("description", description);

    try {
      const response = await axios.post("/api/video-upload", formdata, {
        // A 200 MB upload over mobile data takes minutes. Without this the page
        // looks frozen for the whole of it.
        onUploadProgress: (event) => {
          if (!event.total) return;
          setProgress(Math.round((event.loaded / event.total) * 100));
        },
      });
      if (response.status === 200) {
        toast.success("File uploaded successfully!", {
          position: "top-right",
          autoClose: 3000,
          // Used to push to /videos, which is not a route in this app, so a
          // successful upload always landed the user on a 404.
          onClose: () => router.push("/home"),
        });
      } else {
        toast.warn("Unexpected response from the server.", {
          position: "top-right",
          autoClose: 3000,
        });
      }
    } catch (error) {
      // Previously only logged to the console, so a failed upload looked
      // identical to no upload at all from the user's point of view.
      console.error(error);
      const message =
        axios.isAxiosError(error) && error.response
          ? error.response.data?.error ?? `Upload failed (${error.response.status})`
          : "Upload failed. Check your connection and try again.";
      toast.error(message, { position: "top-right", autoClose: 8000 });
    } finally {
      setIsUploading(false);
      setProgress(null);
    }
  };

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Upload Video</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          {/* Every label here used to be a bare <label> beside its input with no
              htmlFor, so none of the three controls had an accessible name and
              clicking a label focused nothing. */}
          <label className="label" htmlFor="video-title">
            <span className="label-text">Title</span>
          </label>
          <input
            id="video-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="input input-bordered w-full"
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="video-description">
            <span className="label-text">Description</span>
          </label>
          <textarea
            id="video-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="textarea textarea-bordered w-full"
          />
        </div>
        <div>
          <label className="label" htmlFor="video-file">
            <span className="label-text">
              Video file (max {formatBytes(MAX_VIDEO_BYTES)})
            </span>
          </label>
          <input
            id="video-file"
            type="file"
            accept="video/*"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="file-input file-input-bordered w-full"
            required
          />
        </div>

        {isUploading && (
          <div role="status" aria-live="polite">
            <p className="text-sm mb-1">
              {progress === null
                ? "Uploading…"
                : progress < 100
                  ? `Uploading… ${progress}%`
                  : "Uploaded. Compressing on the server…"}
            </p>
            <progress
              className="progress progress-primary w-full"
              // An omitted value renders the indeterminate bar, which is the
              // honest state once the bytes are sent and Cloudinary is working.
              {...(progress === null || progress >= 100 ? {} : { value: progress })}
              max={100}
            />
          </div>
        )}

        <button
          type="submit"
          className="btn btn-primary"
          disabled={isUploading}
        >
          {isUploading ? "Uploading..." : "Upload Video"}
        </button>
      </form>
    </div>
  );
}

export default VideoUpload;
