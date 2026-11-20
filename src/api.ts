import { call as invoke, isDesktop } from "./lib/platform";
import type {
  Artist,
  BackendStatus,
  CacheInfo,
  Collection,
  ImportResult,
  Item,
  Lyrics,
  PreparedStream,
  Shelf,
  SourceTrack,
  StreamInfo,
} from "./types";

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

/** Resolve a song and get its local proxy URL + loudness. */
export const prepareStream = (videoId: string, forceRefresh = false) =>
  invoke<PreparedStream>("prepare_stream", { videoId, forceRefresh });

/** Offline cache size limit in MB (0 = off). */
/** The offline cache lives on the desktop; the web server manages its own. */
export const setAudioCache = (limitMb: number) => {
  if (isDesktop) invoke("set_audio_cache", { limitMb }).catch(() => {});
};
export const audioCacheInfo = () => invoke<CacheInfo>("audio_cache_info");
export const clearAudioCache = () => invoke("clear_audio_cache");

export const importSpotify = (url: string) => invoke<ImportResult>("import_spotify", { url });
export const importTracks = (name: string, tracks: SourceTrack[]) =>
  invoke<ImportResult>("import_tracks", { name, tracks });
