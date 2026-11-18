import type { Item } from "../types";

export function formatTime(ms: number): string {
  if (!ms || !isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const GOOGLE_IMG = /^https:\/\/(lh\d\.googleusercontent\.com|yt\d\.ggpht\.com|yt\d\.googleusercontent\.com)\//;
const SIZE_SUFFIX = /=[wsh]\d+[^/?=]*$/;

/**
 * Album/artist art on Google image hosts ends in `=w60-h60-...`; rewrite it to
 * the size we actually need so it isn't a blurry upscaled thumbnail.
 */
export function sizedImageUrl(url: string, size: number): string {
  if (GOOGLE_IMG.test(url)) {
    const m = SIZE_SUFFIX.exec(url);
    if (m) return `${url.slice(0, m.index)}=w${size}-h${size}-l90-rj`;
  }
  return url;
}

/** `size` is the pixel size to request (use ~2x the CSS size for sharpness). */
export function pickThumb(item: Item, size = 320): string | null {
  const ts = item.thumbnails ?? [];
  if (ts.length === 0) return null;
  const sorted = [...ts].sort((a, b) => a.width - b.width);
  const largest = sorted[sorted.length - 1];
  if (GOOGLE_IMG.test(largest.url)) return sizedImageUrl(largest.url, size);
  // Video thumbnails (i.ytimg.com): take the biggest; CSS crops to square.
  if (largest.url.includes("ytimg.com")) return largest.url;
  return (sorted.find((t) => t.width >= size) ?? largest).url;
}

export function artistLabel(item: Item): string {
  if (item.artists && item.artists.length > 0) return item.artists.join(", ");
  return item.subtitle || "Unknown artist";
}

export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return "night";
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

/** Never show multi-line / raw error text to the user. */
export function friendlyError(e: unknown): string {
  const raw = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  const line = raw.split("\n")[0].trim();
  if (!line || line.length > 100) return "Couldn't load this track";
  return line;
}
