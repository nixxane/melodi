export interface Thumbnail {
  url: string;
  width: number;
  height: number;
}

export interface Item {
  kind: string;
  video_id: string | null;
  browse_id: string | null;
  title: string;
  subtitle: string;
  artists: string[];
  duration_ms: number | null;
  thumbnails: Thumbnail[];
  explicit: boolean;
  artist_id?: string | null;
  album_id?: string | null;
}

export interface Radio {
  video_id: string;
  playlist_id: string;
}

export interface Artist {
  name: string;
  description: string;
  audience: string;
  thumbnails: Thumbnail[];
  radio: Radio | null;
  shuffle: Radio | null;
  top_songs: Item[];
  top_songs_id: string | null;
  shelves: Shelf[];
}

export interface Collection {
  kind: "album" | "playlist";
  browse_id: string;
  title: string;
  subtitle: string;
  stats: string;
  description: string;
  artist: string | null;
  artist_id: string | null;
  thumbnails: Thumbnail[];
  tracks: Item[];
  shelves: Shelf[];
}

export interface LyricLine {
  t: number;
  text: string;
}

export interface Lyrics {
  source: string;
  synced: LyricLine[] | null;
  plain: string | null;
}

/** A page in the main panel. Top-level views reset the back stack. */
export type Route =
  | { name: "home" }
  | { name: "search" }
  | { name: "queue" }
  | { name: "lyrics" }
  | { name: "artist"; id: string; title: string }
  | { name: "collection"; id: string; title: string }
  | { name: "playlist"; id: string };

export interface Shelf {
  title: string;
  items: Item[];
}

export interface StreamInfo {
  url: string;
  hls: boolean;
}

export interface BackendStatus {
  ytdlp_available: boolean;
  path: string | null;
  version: string | null;
}

export type View = "home" | "search" | "queue";

export type RepeatMode = "off" | "all" | "one";

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
}
