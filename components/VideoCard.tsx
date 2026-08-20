import React, { useCallback, useState } from "react";
import { getCldImageUrl, getCldVideoUrl } from "next-cloudinary";
import { Download, Clock, FileDown, FileUp, Play, Square, Trash } from "lucide-react";
import dayjs from "dayjs";
import realtiveTime from "dayjs/plugin/relativeTime";
import { filesize } from "filesize";
import { Video } from "@/types";

dayjs.extend(realtiveTime);

interface VideoCardProps {
  video: Video;
  onDelete: (id: string) => void;
}

/**
 * Cloudinary URL building needs the cloud name in the browser bundle. Without
 * it the helpers produce a URL with "undefined" in it, which fails as a broken
 * image with no explanation. Checked once here so the card can say what is
 * actually wrong.
 */
const CLOUD_NAME = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;

/** Cloudinary puts this in Content-Disposition, so it becomes the saved filename. */
function attachmentName(title: string): string {
  const safe = title.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.slice(0, 60) || "video";
}

const VideoCard: React.FC<VideoCardProps> = ({ video, onDelete }) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const getThumbnailUrl = useCallback((publicId: string) => {
    return getCldImageUrl({
      src: publicId,
      width: 400,
      height: 225,
      crop: "fill",
      gravity: "auto",
      format: "jpg",
      quality: "auto",
      assetType: "video",
    });
  }, []);

  const getPreviewVideoUrl = useCallback((publicId: string) => {
    return getCldVideoUrl({
      src: publicId,
      width: 400,
      height: 225,
      rawTransformations: ["e_preview:duration_15:max_seg_9:min_seg_dur_1"],
    });
  }, []);

  /**
   * `fl_attachment` makes Cloudinary send Content-Disposition: attachment, so
   * the browser saves the file. The HTML `download` attribute cannot do this
   * job: browsers ignore it entirely on a cross-origin URL, so the old download
   * button simply navigated to res.cloudinary.com and played the video in a
   * new tab.
   */
  const getDownloadUrl = useCallback((publicId: string, title: string) => {
    const url = getCldVideoUrl({ src: publicId, width: 1920, height: 1080 });
    return url.replace("/upload/", `/upload/fl_attachment:${attachmentName(title)}/`);
  }, []);

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
        {!CLOUD_NAME ? (
          <div className="w-full h-full flex items-center justify-center p-4 text-center">
            <p className="text-sm opacity-70">
              Preview unavailable: NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME is not set.
            </p>
          </div>
        ) : isPlaying && !previewError ? (
          <video
            src={getPreviewVideoUrl(video.publicId)}
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
            src={getThumbnailUrl(video.publicId)}
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

        {CLOUD_NAME && (
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
              {CLOUD_NAME && (
                <a
                  className="btn btn-primary btn-sm"
                  href={getDownloadUrl(video.publicId, video.title)}
                >
                  <Download size={16} aria-hidden="true" />
                  Download
                </a>
              )}
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
