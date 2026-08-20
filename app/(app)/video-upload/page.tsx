"use client";
import React, { useState } from "react";
import axios from "axios";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

function VideoUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isUploading, setIsUploading] = useState(false);

  const router = useRouter();

  const MAX_FILE_SIZE_MB = 200;
  const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
      // The message used to say 5MB while the constant allowed 200MB.
      toast.error(`File is too large. Maximum size is ${MAX_FILE_SIZE_MB}MB.`, {
        position: "top-right",
        autoClose: 5000, // Close after 5 seconds
        hideProgressBar: false,
        closeOnClick: true,
        pauseOnHover: true,
        draggable: true,
        progress: undefined,
      });
      return;
    }

    setIsUploading(true);
    const formdata = new FormData();
    formdata.append("file", file);
    formdata.append("title", title);
    formdata.append("description", description);

    try {
      const response = await axios.post("/api/video-upload", formdata);
      //check for 200 response
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
      toast.error(message, { position: "top-right", autoClose: 5000 });
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Upload Video</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="label">
            <span className="label-text">Title</span>
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="input input-bordered w-full"
            required
          />
        </div>
        <div>
          <label className="label">
            <span className="label-text">Description</span>
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="textarea textarea-bordered w-full"
          />
        </div>
        <div>
          <label className="label">
            <span className="label-text">Video File</span>
          </label>
          <input
            type="file"
            accept="video/*"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="file-input file-input-bordered w-full"
            required
          />
        </div>
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
