export interface Video {
  id: string;
  title: string;
  /** Optional in the Prisma schema, so it really can be null. */
  description: string | null;
  publicId: string;
  /** Byte counts are stored as strings in the schema. */
  originalSize: string;
  compressedSize: string;
  duration: number;
  /** Serialised over JSON, so these arrive as ISO strings, not Date objects. */
  createdAt: string;
  updatedAt: string;
}
