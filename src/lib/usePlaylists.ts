import { useCallback, useState } from "react";
import type { Item } from "../types";
import { loadJSON, saveJSON } from "./storage";

const KEY = "melodi.playlists";

export interface Playlist {
  id: string;
  name: string;
  items: Item[];
  created: number;
  updated: number;
}

const newId = () => `pl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Only what a track needs to be shown and played again. */
export const slim = (i: Item): Item => ({
  kind: "song",
  video_id: i.video_id,
  browse_id: null,
  title: i.title,
  subtitle: i.subtitle,
  artists: i.artists,
  duration_ms: i.duration_ms,
  thumbnails: i.thumbnails.slice(-2),
  explicit: i.explicit,
  artist_id: i.artist_id ?? null,
  album_id: i.album_id ?? null,
});

/** User playlists, stored locally. */
export function usePlaylists() {
  const [playlists, setPlaylists] = useState<Playlist[]>(() => {
    const v = loadJSON<unknown>(KEY, []);
    return Array.isArray(v) ? (v as Playlist[]).filter((p) => p && p.id && Array.isArray(p.items)) : [];
  });

  const update = useCallback((fn: (list: Playlist[]) => Playlist[]) => {
    setPlaylists((list) => {
      const next = fn(list);
      saveJSON(KEY, next);
      return next;
    });
  }, []);

  const edit = useCallback(
    (id: string, fn: (p: Playlist) => Playlist) =>
      update((list) => list.map((p) => (p.id === id ? { ...fn(p), updated: Date.now() } : p))),
    [update]
  );

  /** Create a playlist; returns its id. */
  const create = useCallback(
    (name: string, items: Item[] = []) => {
      const id = newId();
      const now = Date.now();
      const songs = dedupe(items.filter((i) => i.video_id).map(slim));
      update((list) => [...list, { id, name: name.trim() || "untitled", items: songs, created: now, updated: now }]);
      return id;
    },
    [update]
  );

  /** Add songs, skipping ones already in the playlist. Returns how many were added. */
  const add = useCallback(
    (id: string, items: Item[]) => {
      const p = playlists.find((x) => x.id === id);
      if (!p) return 0;
      const have = new Set(p.items.map((i) => i.video_id));
      const fresh = dedupe(items.filter((i) => i.video_id && !have.has(i.video_id)).map(slim));
      if (fresh.length) edit(id, (pl) => ({ ...pl, items: [...pl.items, ...fresh] }));
      return fresh.length;
    },
    [playlists, edit]
  );

  const removeAt = useCallback(
    (id: string, index: number) => edit(id, (p) => ({ ...p, items: p.items.filter((_, i) => i !== index) })),
    [edit]
  );

  const move = useCallback(
    (id: string, from: number, to: number) =>
      edit(id, (p) => {
        const items = [...p.items];
        const [it] = items.splice(from, 1);
        items.splice(to, 0, it);
        return { ...p, items };
      }),
    [edit]
  );

  const rename = useCallback(
    (id: string, name: string) => edit(id, (p) => ({ ...p, name: name.trim() || p.name })),
    [edit]
  );

  const remove = useCallback((id: string) => update((list) => list.filter((p) => p.id !== id)), [update]);

  return { playlists, create, add, removeAt, move, rename, remove };
}

function dedupe(items: Item[]) {
  const seen = new Set<string>();
  return items.filter((i) => {
    if (!i.video_id || seen.has(i.video_id)) return false;
    seen.add(i.video_id);
    return true;
  });
}

export type PlaylistsApi = ReturnType<typeof usePlaylists>;
