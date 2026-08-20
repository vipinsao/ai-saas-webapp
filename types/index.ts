/**
 * What `GET /api/videos` returns for one video.
 *
 * There is deliberately no `publicId` here. It is a capability: with
 * public-delivery uploads it was, on its own, a working download link for
 * anybody who had it, and the list query used to hand every user every other
 * user's. The browser now receives signed URLs, minted per request for videos
 * the caller owns.
 */
export interface VideoListItem {
  id: string;
  title: string;
  /** Optional in the Prisma schema, so it really can be null. */
  description: string | null;
  /** Byte counts are stored as strings in the schema. */
  originalSize: string;
  compressedSize: string;
  duration: number;
  /** Serialised over JSON, so this arrives as an ISO string, not a Date. */
  createdAt: string;
  thumbnailUrl: string;
  previewUrl: string;
  downloadUrl: string;
}
