"use client";
import React, { useState, useEffect, useCallback } from "react";
import axios from "axios";
import VideoCard from "@/components/VideoCard";
import { VideoListItem } from "@/types";

function Home() {
  const [videos, setVideos] = useState<VideoListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchVideos = useCallback(async () => {
    try {
      const response = await axios.get("/api/videos");
      if (Array.isArray(response.data)) {
        setVideos(response.data);
      } else {
        throw new Error("Unexpected response format");
      }
    } catch (err) {
      console.log(err);
      setError("Failed to fetch videos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVideos();
  }, [fetchVideos]);

  const handleDelete = useCallback(async (id: string) => {
    setError(null);
    try {
      await axios.delete(`/api/videos/${id}`);
      setVideos((previous) => previous.filter((video) => video.id !== id));
    } catch (err) {
      console.error("Failed to delete video:", err);
      // The route refuses to drop the row if the Cloudinary asset could not be
      // deleted, and says why. Showing "Failed to delete video" instead would
      // hide the one detail that tells the user whether to retry.
      const message =
        axios.isAxiosError(err) && err.response
          ? err.response.data?.error ?? `Delete failed (${err.response.status})`
          : "Delete failed. Check your connection and try again.";
      setError(message);
    }
  }, []);

  if (loading) {
    return <div>Loading...</div>;
  }

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-2xl font-bold mb-4">Videos</h1>
      {error && (
        <div role="alert" className="alert alert-error mb-4">
          <span>{error}</span>
        </div>
      )}
      {videos.length === 0 ? (
        <div className="text-center text-lg text-gray-500">
          No videos available
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {videos.map((video) => (
            <VideoCard key={video.id} video={video} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}

export default Home;
