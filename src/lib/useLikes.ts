import { useCallback, useMemo, useState } from "react";
import type { Item } from "../types";
import { loadJSON, saveJSON } from "./storage";
import { slim } from "./usePlaylists";

const KEY = "melodi.likes";

/** Liked songs, newest first, kept locally. */
export function useLikes() {
  const [likes, setLikes] = useState<Item[]>(() => {
    const v = loadJSON<unknown>(KEY, []);
    return Array.isArray(v) ? (v as Item[]).filter((i) => i && i.video_id) : [];
  });

  const ids = useMemo(() => new Set(likes.map((i) => i.video_id)), [likes]);

  const save = useCallback((fn: (l: Item[]) => Item[]) => {
    setLikes((l) => {
      const next = fn(l);
      saveJSON(KEY, next);
      return next;
    });
  }, []);

  const isLiked = useCallback((id: string | null | undefined) => !!id && ids.has(id), [ids]);

  /** Like or unlike; returns the new state (true = liked). */
  const toggle = useCallback(
    (item: Item) => {
      if (!item.video_id) return false;
      const liked = ids.has(item.video_id);
      save((l) => (liked ? l.filter((x) => x.video_id !== item.video_id) : [slim(item), ...l]));
      return !liked;
    },
    [ids, save]
  );

  const unlike = useCallback(
    (videoId: string) => save((l) => l.filter((x) => x.video_id !== videoId)),
    [save]
  );

  return { likes, isLiked, toggle, unlike };
}

export type LikesApi = ReturnType<typeof useLikes>;
