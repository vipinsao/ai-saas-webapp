/**
 * The preset table is imported by the browser bundle as well as the API route,
 * so it deliberately lives apart from lib/imagePipeline.ts — that module pulls
 * in sharp, a native Node addon that must never reach the client bundle.
 */

export interface SocialFormat {
  /** Label shown in the UI. */
  label: string;
  width: number;
  height: number;
}

export const SOCIAL_FORMATS = {
  "instagram-square": { label: "Instagram Square (1:1)", width: 1080, height: 1080 },
  "instagram-portrait": { label: "Instagram Portrait (4:5)", width: 1080, height: 1350 },
  "twitter-post": { label: "Twitter Post (16:9)", width: 1200, height: 675 },
  "twitter-header": { label: "Twitter Header (3:1)", width: 1500, height: 500 },
  "facebook-cover": { label: "Facebook Cover (205:78)", width: 820, height: 312 },
} as const satisfies Record<string, SocialFormat>;

export type SocialFormatId = keyof typeof SOCIAL_FORMATS;

export const SOCIAL_FORMAT_IDS = Object.keys(SOCIAL_FORMATS) as SocialFormatId[];

export function isSocialFormatId(value: string): value is SocialFormatId {
  return Object.prototype.hasOwnProperty.call(SOCIAL_FORMATS, value);
}
