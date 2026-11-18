/** Recognise YouTube / YouTube Music links pasted into the search box. */

export type YtLink =
  /** A playlist that has its own page (regular playlists, albums, auto-generated). */
  | { kind: "playlist"; listId: string }
  /** A mix / radio (RD…) that only exists relative to a song. */
  | { kind: "mix"; listId: string; videoId: string }
  /** A single song / video. */
  | { kind: "video"; videoId: string }
  /** Recognised but needs the user's account (Liked music, Watch later). */
  | { kind: "private"; what: string };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{2,}$/;
const HOSTS = /(^|\.)youtube\.com$|^youtu\.be$|(^|\.)youtube-nocookie\.com$/;

export function parseYouTubeLink(input: string): YtLink | null {
  const text = input.trim();
  if (!/^(https?:\/\/)?[\w.-]*(youtube\.com|youtu\.be|youtube-nocookie\.com)\//i.test(text)) return null;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!HOSTS.test(host)) return null;

  const list = url.searchParams.get("list");
  let videoId = url.searchParams.get("v");
  if (host === "youtu.be") videoId = url.pathname.slice(1).split("/")[0];
  const shorts = url.pathname.match(/^\/(shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
  if (shorts) videoId = shorts[2];
  if (videoId && !VIDEO_ID.test(videoId)) videoId = null;

  if (list && LIST_ID.test(list)) {
    if (list === "LM" || list === "LL") return { kind: "private", what: "Liked music" };
    if (list === "WL") return { kind: "private", what: "Watch later" };
    // Personal mixes / radios (RD…) have no page of their own, except the
    // RDCLAK… playlists YouTube Music curates, which do.
    if (list.startsWith("RD") && !list.startsWith("RDCLAK")) {
      return videoId ? { kind: "mix", listId: list, videoId } : null;
    }
    return { kind: "playlist", listId: list };
  }
  if (videoId) return { kind: "video", videoId };
  return null;
}
