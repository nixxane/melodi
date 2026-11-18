import { useCallback, useEffect, useRef, useState } from "react";
import { prefetchStream, upNext } from "../api";
import type { Item, RepeatMode } from "../types";
import type { PlayerApi, PlayerCallbacks } from "./usePlayer";
import { loadJSON, removeKey, saveJSON } from "./storage";
import { readSettings } from "./useSettings";

const SESSION_KEY = "melodi.session";
const MAX_SAVED = 300;
const MAX_FAILURES = 3;

interface SavedSession {
  queue: Item[];
  index: number | null;
  position: number;
  autoIds: string[];
}

type Notify = (message: string, kind?: "info" | "error") => void;

const idOf = (i: Item) => i.video_id ?? "";

/**
 * Queue, shuffle/repeat, autoplay radio and session persistence.
 *
 * The queue is kept in a ref as well as in state so that player callbacks
 * (which fire outside React's render cycle) always see the latest value.
 */
export function useQueue(player: PlayerApi, notify: Notify) {
  const saved = useRef<SavedSession | null>(null);
  if (saved.current === null) {
    const s = readSettings().restoreSession ? loadJSON<SavedSession | null>(SESSION_KEY, null) : null;
    saved.current =
      s && Array.isArray(s.queue) && s.queue.length > 0
        ? s
        : { queue: [], index: null, position: 0, autoIds: [] };
  }
  const initial = saved.current;

  const state = useRef({
    queue: initial.queue,
    index: (initial.index != null && initial.queue[initial.index]
      ? initial.index
      : null) as number | null,
  });
  const [queue, setQueue] = useState<Item[]>(state.current.queue);
  const [currentIndex, setCurrentIndex] = useState<number | null>(state.current.index);
  const [autoIds, setAutoIds] = useState<Set<string>>(() => new Set(initial.autoIds ?? []));
  const autoIdsRef = useRef(autoIds);

  const [shuffle, setShuffleState] = useState<boolean>(() => loadJSON("melodi.shuffle", false));
  const [repeat, setRepeatState] = useState<RepeatMode>(() => {
    const r = loadJSON<string>("melodi.repeat", "off");
    return r === "all" || r === "one" ? r : "off";
  });
  const [autoplay, setAutoplayState] = useState<boolean>(() => loadJSON("melodi.autoplay", true));
  const shuffleRef = useRef(shuffle);
  const repeatRef = useRef(repeat);
  const autoplayRef = useRef(autoplay);

  // Shuffle bookkeeping.
  const played = useRef(new Set<string>());
  const history = useRef<string[]>([]);
  const nextPick = useRef<string | null>(null);
  const failures = useRef(0);
  const radioSeed = useRef<string | null>(null);
  const playerRef = useRef(player);
  playerRef.current = player;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const commit = useCallback((q: Item[], i: number | null) => {
    state.current = { queue: q, index: i };
    setQueue(q);
    setCurrentIndex(i);
  }, []);

  const setAuto = useCallback((s: Set<string>) => {
    autoIdsRef.current = s;
    setAutoIds(s);
  }, []);

  // ---- navigation helpers ------------------------------------------------

  const hasNext = (): boolean => {
    const { queue: q, index: i } = state.current;
    if (q.length === 0) return false;
    if (i == null) return true;
    if (repeatRef.current === "all") return q.length > 0;
    if (shuffleRef.current) {
      return q.some((it, j) => j !== i && !played.current.has(idOf(it)));
    }
    return i + 1 < q.length;
  };

  const hasPrev = (): boolean => {
    const { queue: q, index: i } = state.current;
    if (i == null) return false;
    if (shuffleRef.current) return history.current.length > 0 || repeatRef.current === "all";
    return i > 0 || (repeatRef.current === "all" && q.length > 1);
  };

  /** Index of the track that "next" would play, or null. Stable for shuffle. */
  const peekNext = (): number | null => {
    const { queue: q, index: i } = state.current;
    if (q.length === 0) return null;
    if (i == null) return 0;

    if (shuffleRef.current) {
      const candidates = () =>
        q.map((_, j) => j).filter((j) => j !== i && !played.current.has(idOf(q[j])));
      let cand = candidates();
      if (cand.length === 0) {
        if (repeatRef.current !== "all") return null;
        if (q.length === 1) return 0;
        played.current = new Set([idOf(q[i])]);
        nextPick.current = null;
        cand = candidates();
      }
      const keep = nextPick.current;
      const kept = keep ? cand.find((j) => idOf(q[j]) === keep) : undefined;
      if (kept !== undefined) return kept;
      const pick = cand[Math.floor(Math.random() * cand.length)];
      nextPick.current = idOf(q[pick]);
      return pick;
    }

    if (i + 1 < q.length) return i + 1;
    return repeatRef.current === "all" ? 0 : null;
  };

  const startAt = (index: number, pushHistory: boolean) => {
    const { queue: q, index: cur } = state.current;
    const item = q[index];
    if (!item || !item.video_id) return;
    if (pushHistory && cur != null && q[cur]) {
      history.current.push(idOf(q[cur]));
      if (history.current.length > 100) history.current.shift();
    }
    played.current.add(idOf(item));
    nextPick.current = null;
    commit(q, index);
    playerRef.current.play(item);
  };

  // ---- public actions -----------------------------------------------------

  /** Play `list[index]` and make `list` the queue. */
  const playList = (list: Item[], index: number) => {
    const target = list[index];
    const songs = list.filter((i) => i.video_id);
    if (songs.length === 0 || !target || !target.video_id) {
      notifyRef.current("No playable tracks found.");
      return;
    }
    const idx = songs.findIndex((s) => s.video_id === target.video_id);
    played.current = new Set();
    history.current = [];
    failures.current = 0;
    radioSeed.current = null;
    setAuto(new Set());
    commit(songs, idx);
    startAt(idx, false);
  };

  const playAt = (index: number) => {
    failures.current = 0;
    startAt(index, true);
  };

  const next = () => {
    const n = peekNext();
    if (n == null) return;
    failures.current = 0;
    startAt(n, true);
  };

  const prev = () => {
    const p = playerRef.current;
    const { queue: q, index: i } = state.current;
    if (i == null) return;
    if (p.getCurrentTime() > 3) {
      p.seek(0);
      return;
    }
    if (shuffleRef.current) {
      const id = history.current.pop();
      const j = id ? q.findIndex((it) => idOf(it) === id) : -1;
      if (j >= 0) {
        failures.current = 0;
        startAt(j, false);
        return;
      }
    } else if (i > 0) {
      failures.current = 0;
      startAt(i - 1, false);
      return;
    } else if (repeatRef.current === "all" && q.length > 1) {
      failures.current = 0;
      startAt(q.length - 1, false);
      return;
    }
    p.seek(0);
  };

  const playNext = (item: Item) => {
    if (!item.video_id) return;
    const { queue: q, index: i } = state.current;
    if (q.length === 0 || i == null) {
      playList([item], 0);
      return;
    }
    const cur = q[i];
    if (idOf(cur) === item.video_id) return;
    const without = q.filter((x) => idOf(x) !== item.video_id);
    const ci = without.findIndex((x) => idOf(x) === idOf(cur));
    without.splice(ci + 1, 0, item);
    if (autoIdsRef.current.has(item.video_id)) {
      const s = new Set(autoIdsRef.current);
      s.delete(item.video_id);
      setAuto(s);
    }
    nextPick.current = item.video_id;
    commit(without, ci);
    notifyRef.current(`“${item.title}” will play next`);
  };

  const addToQueue = (item: Item) => {
    if (!item.video_id) return;
    const { queue: q, index: i } = state.current;
    if (q.length === 0 || i == null) {
      playList([item], 0);
      return;
    }
    if (q.some((x) => idOf(x) === item.video_id)) {
      notifyRef.current("Already in your queue");
      return;
    }
    // Manual adds go before any autoplay tail so they aren't pushed behind it.
    const firstAuto = q.findIndex((x, j) => j > i && autoIdsRef.current.has(idOf(x)));
    const out = [...q];
    out.splice(firstAuto >= 0 ? firstAuto : out.length, 0, item);
    commit(out, i);
    notifyRef.current(`Added “${item.title}” to the queue`);
  };

  const removeAt = (index: number) => {
    const { queue: q, index: i } = state.current;
    if (index < 0 || index >= q.length || index === i) return;
    const out = q.filter((_, j) => j !== index);
    commit(out, i != null && index < i ? i - 1 : i);
  };

  const move = (from: number, to: number) => {
    const { queue: q, index: i } = state.current;
    if (from === to || from < 0 || to < 0 || from >= q.length || to >= q.length) return;
    if (i == null) return;
    const cur = q[i];
    const out = [...q];
    const [item] = out.splice(from, 1);
    out.splice(to, 0, item);
    // A dragged track becomes "manual": it leaves the autoplay set.
    if (autoIdsRef.current.has(idOf(item))) {
      const s = new Set(autoIdsRef.current);
      s.delete(idOf(item));
      setAuto(s);
    }
    commit(out, out.indexOf(cur));
  };

  const clear = () => {
    played.current = new Set();
    history.current = [];
    radioSeed.current = null;
    setAuto(new Set());
    commit([], null);
    removeKey(SESSION_KEY);
    playerRef.current.pause();
  };

  const setShuffle = (on: boolean) => {
    shuffleRef.current = on;
    setShuffleState(on);
    saveJSON("melodi.shuffle", on);
    const { queue: q, index: i } = state.current;
    played.current = new Set(i != null && q[i] ? [idOf(q[i])] : []);
    history.current = [];
    nextPick.current = null;
  };

  const cycleRepeat = () => {
    const nextMode: RepeatMode =
      repeatRef.current === "off" ? "all" : repeatRef.current === "all" ? "one" : "off";
    repeatRef.current = nextMode;
    setRepeatState(nextMode);
    saveJSON("melodi.repeat", nextMode);
  };

  const setAutoplay = (on: boolean) => {
    autoplayRef.current = on;
    setAutoplayState(on);
    saveJSON("melodi.autoplay", on);
    if (on) maybeRadio();
  };

  // ---- autoplay radio ------------------------------------------------------

  const maybeRadio = () => {
    const { queue: q, index: i } = state.current;
    if (i == null || !q[i]) return;
    if (!autoplayRef.current || repeatRef.current !== "off" || hasNext()) return;
    const seed = idOf(q[i]);
    if (radioSeed.current === seed) return;
    radioSeed.current = seed;
    upNext(seed)
      .then((items) => {
        appendFresh(items, true);
      })
      .catch(() => {
        radioSeed.current = null;
      });
  };

  /** Append radio tracks not already in the queue. */
  const appendFresh = (items: Item[], markAuto: boolean) => {
    const { queue: cur, index: ci } = state.current;
    const have = new Set(cur.map(idOf));
    const fresh = items.filter((it) => it.video_id && !have.has(idOf(it)));
    if (fresh.length === 0) return 0;
    if (markAuto) {
      const s = new Set(autoIdsRef.current);
      fresh.forEach((it) => s.add(idOf(it)));
      setAuto(s);
    }
    commit([...cur, ...fresh], ci);
    return fresh.length;
  };

  /** Play a song now and queue up similar songs after it. */
  const startRadio = (item: Item) => {
    if (!item.video_id) return;
    playList([item], 0);
    radioSeed.current = idOf(item);
    upNext(item.video_id)
      .then((items) => {
        const n = appendFresh(items, false);
        notifyRef.current(n ? `Radio: ${n} similar songs queued` : "No similar songs found");
      })
      .catch(() => notifyRef.current("Couldn't start radio", "error"));
  };

  /** Play a ready-made radio playlist (e.g. an artist's Mix). */
  const playRadio = (videoId: string, playlistId: string, shuffleIt = false) =>
    upNext(videoId, playlistId)
      .then((items) => {
        if (items.length === 0) {
          notifyRef.current("Nothing to play", "error");
          return;
        }
        const list = shuffleIt ? [...items].sort(() => Math.random() - 0.5) : items;
        playList(list, 0);
      })
      .catch(() => notifyRef.current("Couldn't load the mix", "error"));

  // ---- player callbacks ----------------------------------------------------

  const handlers: PlayerCallbacks = {
    onEnded: () => {
      if (repeatRef.current === "one") {
        playerRef.current.replay();
        return;
      }
      const n = peekNext();
      if (n != null) {
        failures.current = 0;
        startAt(n, true);
      }
    },
    onError: (message) => {
      notifyRef.current(message, "error");
      failures.current += 1;
      if (failures.current >= MAX_FAILURES) return;
      const n = peekNext();
      if (n != null && n !== state.current.index) startAt(n, true);
    },
    onStarted: () => {
      failures.current = 0;
      const n = peekNext();
      const item = n != null ? state.current.queue[n] : null;
      if (item?.video_id) prefetchStream(item.video_id);
      maybeRadio();
    },
  };

  // ---- session persistence -------------------------------------------------

  const persist = useCallback(() => {
    const { queue: q, index: i } = state.current;
    if (q.length === 0) {
      removeKey(SESSION_KEY);
      return;
    }
    const session: SavedSession = {
      queue: q.slice(0, MAX_SAVED),
      index: i != null && i < MAX_SAVED ? i : null,
      position: playerRef.current.getCurrentTime(),
      autoIds: [...autoIdsRef.current],
    };
    saveJSON(SESSION_KEY, session);
  }, []);

  useEffect(() => {
    // Restore the previous session paused; the stream resolves on first play.
    const { queue: q, index: i } = state.current;
    if (i != null && q[i]) playerRef.current.load(q[i], initial.position || 0);

    const timer = window.setInterval(persist, 5000);
    const onHide = () => persist();
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save immediately when the queue itself changes.
  useEffect(() => {
    persist();
  }, [queue, currentIndex, persist]);

  return {
    queue,
    currentIndex,
    autoIds,
    shuffle,
    repeat,
    autoplay,
    canNext: hasNext(),
    canPrev: hasPrev(),
    handlers,
    playList,
    startRadio,
    playRadio,
    playAt,
    next,
    prev,
    playNext,
    addToQueue,
    removeAt,
    move,
    clear,
    setShuffle,
    cycleRepeat,
    setAutoplay,
  };
}

export type QueueApi = ReturnType<typeof useQueue>;
