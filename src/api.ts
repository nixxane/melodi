import { invoke } from "@tauri-apps/api/core";
import type { Artist, BackendStatus, Collection, Item, Lyrics, Shelf, StreamInfo } from "./types";

export const search = (query: string) => invoke<Item[]>("search", { query });

export const browseHome = () => invoke<Shelf[]>("browse_home");

export const browseArtist = (browseId: string) => invoke<Artist>("browse_artist", { browseId });

export const browseCollection = (browseId: string) =>
  invoke<Collection>("browse_collection", { browseId });

/** Song radio for `videoId`, or the given radio playlist (e.g. an artist Mix). */
export const upNext = (videoId: string, playlistId?: string) =>
  invoke<Item[]>("up_next", { videoId, playlistId: playlistId ?? null });

export const fetchLyrics = (item: Item, artist: string) =>
  invoke<Lyrics>("lyrics", {
    videoId: item.video_id ?? "",
    title: item.title,
    artist,
    durationMs: item.duration_ms ?? null,
  });

export const resolveStream = (videoId: string, forceRefresh = false) =>
  invoke<StreamInfo>("resolve_stream", { videoId, forceRefresh });

/** Warm the backend stream cache. Never rejects. */
export const prefetchStream = (videoId: string) => {
  invoke("prefetch_stream", { videoId }).catch(() => {});
};

export const backendStatus = () => invoke<BackendStatus>("backend_status");
