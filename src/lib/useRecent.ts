import { useCallback, useState } from "react";
import type { Item } from "../types";
import { loadJSON, saveJSON } from "./storage";

const KEY = "melodi.recent";
const HIDDEN_KEY = "melodi.hiddenArtists";
const MAX = 30;

/** Recently played songs (most recent first) and hidden artists, kept locally. */
export function useRecent() {
  const [recent, setRecent] = useState<Item[]>(() => {
    const v = loadJSON<unknown>(KEY, []);
    return Array.isArray(v) ? (v as Item[]).filter((i) => i && i.video_id) : [];
  });
  const [hidden, setHidden] = useState<string[]>(() => {
    const v = loadJSON<unknown>(HIDDEN_KEY, []);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  });

  const setRecentSaved = useCallback((fn: (r: Item[]) => Item[]) => {
    setRecent((r) => {
      const next = fn(r);
      saveJSON(KEY, next);
      return next;
    });
  }, []);

  const record = useCallback(
    (item: Item) => {
      if (!item.video_id) return;
      setRecentSaved((r) => [item, ...r.filter((x) => x.video_id !== item.video_id)].slice(0, MAX));
    },
    [setRecentSaved]
  );

  const forget = useCallback(
    (videoId: string) => setRecentSaved((r) => r.filter((x) => x.video_id !== videoId)),
    [setRecentSaved]
  );

  const setHiddenSaved = useCallback((fn: (h: string[]) => string[]) => {
    setHidden((h) => {
      const next = fn(h);
      saveJSON(HIDDEN_KEY, next);
      return next;
    });
  }, []);

  /** Hide an artist from "your artists" (and their songs from recently played). */
  const hideArtist = useCallback(
    (artistId: string) => setHiddenSaved((h) => (h.includes(artistId) ? h : [...h, artistId])),
    [setHiddenSaved]
  );
  const unhideAll = useCallback(() => setHiddenSaved(() => []), [setHiddenSaved]);

  const hiddenSet = new Set(hidden);
  const visible = recent.filter((i) => !i.artist_id || !hiddenSet.has(i.artist_id));

  return { recent: visible, record, forget, hiddenArtists: hidden, hideArtist, unhideAll };
}
