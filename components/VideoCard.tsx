import React, { useCallback, useState } from "react";
import { Download, Clock, FileDown, FileUp, Play, Square, Trash } from "lucide-react";
import dayjs from "dayjs";
import realtiveTime from "dayjs/plugin/relativeTime";
import { filesize } from "filesize";
import { VideoListItem } from "@/types";

dayjs.extend(realtiveTime);

interface VideoCardProps {
  video: VideoListItem;
  onDelete: (id: string) => void;
}

/**
 * This component used to import `next-cloudinary` and build the three delivery
 * URLs itself from `video.publicId`. That cost ~162 kB of JavaScript, and it
 * only worked because uploads were public-delivery: the browser cannot sign a
 * URL, because signing needs the API secret. The URLs now arrive from
 * /api/videos already signed, so the id never leaves the server and the
 * dependency is gone from the bundle entirely.
 */

const VideoCard: React.FC<VideoCardProps> = ({ video, onDelete }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);




  const formatSize = useCallback((size: number) => {
    // filesize() throws on NaN, which a malformed row would otherwise trigger.
    return Number.isFinite(size) ? filesize(size) : "unknown";
  }, []);

  const formatDuration = useCallback((seconds: number) => {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
  }, []);

  const originalBytes = Number(video.originalSize);
  const compressedBytes = Number(video.compressedSize);
  // A zero or unparseable original size used to render "Infinity%" / "NaN%".
  const compressionPercentage =
    Number.isFinite(originalBytes) &&
    originalBytes > 0 &&
    Number.isFinite(compressedBytes)
      ? Math.round((1 - compressedBytes / originalBytes) * 100)
      : null;

  return (
    <div className="card bg-base-100 shadow-xl hover:shadow-2xl transition-all duration-300">
      <figure className="aspect-video relative bg-base-300">
        {isPlaying && !previewError ? (
          <video
            src={video.previewUrl}
            autoPlay
            muted
            loop
            // Without playsInline, iOS Safari takes an autoplaying video
            // fullscreen instead of playing it in the card.
            playsInline
            className="w-full h-full object-cover"
            onError={() => setPreviewError(true)}
          />
        ) : (
          /* Cloudinary is already returning a 400x225 JPEG at quality:auto
             from its CDN. next/image would add a second optimisation hop over
             an image that is already exactly the size it is displayed at. */
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={video.thumbnailUrl}
            alt={video.title}
            width={400}
            height={225}
            loading="lazy"
            className="w-full h-full object-cover"
          />
        )}

        <div className="absolute bottom-2 right-2 bg-base-100 bg-opacity-70 px-2 py-1 rounded-lg text-sm flex items-center">
          <Clock size={16} className="mr-1" aria-hidden="true" />
          {formatDuration(video.duration)}
        </div>

        {(
          // The preview used to be bound to onMouseEnter/onMouseLeave alone, so
          // on a phone -- and for anyone using a keyboard -- the headline
          // feature of the card did not exist and nothing hinted that it was
          // there. One explicit control works for every input device.
          <button
            type="button"
            className="btn btn-sm absolute bottom-2 left-2"
            onClick={() => {
              setPreviewError(false);
              setIsPlaying((playing) => !playing);
            }}
            aria-pressed={isPlaying}
          >
            {isPlaying ? (
              <Square size={16} aria-hidden="true" />
            ) : (
              <Play size={16} aria-hidden="true" />
            )}
            {isPlaying ? "Stop" : "Preview"}
          </button>
        )}

        {previewError && (
          <p className="absolute inset-x-0 top-2 text-center text-sm text-error">
            Preview not available
          </p>
        )}
      </figure>

      <div className="card-body p-4">
        <h2 className="card-title text-lg font-bold">{video.title}</h2>
        <p className="text-sm text-base-content opacity-70 mb-4">
          {video.description}
        </p>
        <p className="text-sm text-base-content opacity-70 mb-4">
          Uploaded {dayjs(video.createdAt).fromNow()}
        </p>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="flex items-center">
            <FileUp size={18} className="mr-2 text-primary" aria-hidden="true" />
            <div>
              <div className="font-semibold">Original</div>
              <div>{formatSize(originalBytes)}</div>
            </div>
          </div>
          <div className="flex items-center">
            <FileDown size={18} className="mr-2 text-secondary" aria-hidden="true" />
            <div>
              <div className="font-semibold">Compressed</div>
              <div>{formatSize(compressedBytes)}</div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap justify-between items-center gap-3 mt-4">
          <div className="text-sm font-semibold">
            Compression:{" "}
            <span className="text-accent">
              {compressionPercentage === null
                ? "n/a"
                : `${compressionPercentage}%`}
            </span>
          </div>

          {confirmingDelete ? (
            // Deleting is irreversible and used to happen on a single tap of a
            // 24px icon whose only label was a `title` attribute, which never
            // appears on a touch device.
            <div className="flex flex-row gap-2 items-center">
              <span className="text-sm">Delete this video?</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setConfirmingDelete(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-sm btn-error"
                onClick={() => {
                  setConfirmingDelete(false);
                  onDelete(video.id);
                }}
              >
                Yes, delete
              </button>
            </div>
          ) : (
            <div className="flex flex-row gap-2">
              <a className="btn btn-primary btn-sm" href={video.downloadUrl}>
                <Download size={16} aria-hidden="true" />
                Download
              </a>
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="btn btn-error btn-sm"
              >
                <Trash size={16} aria-hidden="true" />
                Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default VideoCard;
