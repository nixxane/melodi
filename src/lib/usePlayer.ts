import { useCallback, useEffect, useRef, useState } from "react";
import { resolveStream } from "../api";
import type { Item } from "../types";
import { friendlyError } from "./format";

export interface PlayerCallbacks {
  onEnded?: () => void;
  /** A track failed to load/play (after any automatic retry). */
  onError?: (message: string, item: Item) => void;
  /** Fires once per play request, when audio actually starts. */
  onStarted?: (item: Item) => void;
}

export interface PlayOptions {
  startAt?: number;
}

export interface PlayerApi {
  track: Item | null;
  isPlaying: boolean;
  /** True while resolving a stream or after a stall longer than 300 ms. */
  isLoading: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  /** Bumped on every explicit seek (for the OS media session). */
  seekTick: number;
  play: (item: Item, opts?: PlayOptions) => void;
  /** Show a track as the current one without resolving it (paused). */
  load: (item: Item, position: number) => void;
  toggle: () => void;
  pause: () => void;
  replay: () => void;
  seek: (t: number) => void;
  getCurrentTime: () => number;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  /** Temporary volume multiplier (0..1) for fades; doesn't touch the saved volume. */
  setFade: (f: number) => void;
}

export function usePlayer(callbacks: PlayerCallbacks): PlayerApi {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playToken = useRef(0);
  const trackRef = useRef<Item | null>(null);
  /** video id whose stream is currently loaded in the <audio> element */
  const loadedId = useRef<string | null>(null);
  /** position to resume from when the stream isn't loaded yet */
  const pendingStart = useRef(0);
  const retriedToken = useRef(-1);
  const startedToken = useRef(-1);
  const stallTimer = useRef<number | null>(null);
  const prevVolume = useRef(0.7);
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const [track, setTrack] = useState<Item | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seekTick, setSeekTick] = useState(0);
  const [volume, setVolumeState] = useState<number>(() => {
    try {
      const v = localStorage.getItem("melodi.volume");
      return v ? Math.min(1, Math.max(0, Number(v) || 0)) : 1;
    } catch {
      return 1;
    }
  });
  const volumeRef = useRef(volume);

  const clearStall = () => {
    if (stallTimer.current != null) {
      window.clearTimeout(stallTimer.current);
      stallTimer.current = null;
    }
    setStalled(false);
  };

  const fail = (message: string, item: Item) => {
    loadedId.current = null;
    setResolving(false);
    clearStall();
    cbRef.current.onError?.(message, item);
  };

  /** Point the audio element at a URL and start it, resuming at `startAt`. */
  const startPlayback = async (
    a: HTMLAudioElement,
    url: string,
    startAt: number,
    item: Item,
    token: number
  ) => {
    a.src = url;
    if (startAt > 0) {
      a.addEventListener(
        "loadedmetadata",
        () => {
          if (token === playToken.current) a.currentTime = startAt;
        },
        { once: true }
      );
    }
    await a.play();
    if (token !== playToken.current) return;
    loadedId.current = item.video_id;
    pendingStart.current = 0;
    setIsPlaying(true);
  };

  const getAudio = useCallback((): HTMLAudioElement => {
    if (!audioRef.current) {
      const a = new Audio();
      a.preload = "auto";
      a.volume = volumeRef.current * fadeRef.current;
      a.addEventListener("timeupdate", () => setCurrentTime(a.currentTime));
      a.addEventListener("durationchange", () => {
        if (isFinite(a.duration)) setDuration(a.duration * 1000);
      });
      a.addEventListener("loadedmetadata", () => {
        if (isFinite(a.duration)) setDuration(a.duration * 1000);
      });
      a.addEventListener("playing", () => {
        setIsPlaying(true);
        setResolving(false);
        clearStall();
        const item = trackRef.current;
        if (item && startedToken.current !== playToken.current) {
          startedToken.current = playToken.current;
          cbRef.current.onStarted?.(item);
        }
      });
      a.addEventListener("pause", () => {
        setIsPlaying(false);
        clearStall();
      });
      a.addEventListener("ended", () => {
        setIsPlaying(false);
        setCurrentTime(0);
        cbRef.current.onEnded?.();
      });
      a.addEventListener("waiting", () => {
        if (stallTimer.current == null) {
          stallTimer.current = window.setTimeout(() => setStalled(true), 300);
        }
      });
      a.addEventListener("canplay", clearStall);
      a.addEventListener("error", () => {
        const item = trackRef.current;
        const token = playToken.current;
        if (!item || !a.getAttribute("src")) return;

        // The stream URL may have expired: re-resolve once, bypassing the
        // cache, and resume where we left off.
        if (retriedToken.current !== token) {
          retriedToken.current = token;
          const resumeAt = a.currentTime || pendingStart.current;
          setResolving(true);
          resolveStream(item.video_id ?? "", true)
            .then((info) => {
              if (token !== playToken.current) return;
              if (info.hls) throw "Live streams aren't supported yet";
              return startPlayback(a, info.url, resumeAt, item, token);
            })
            .catch((e) => {
              if (token !== playToken.current) return;
              fail(friendlyError(e), item);
            });
          return;
        }
        fail("Playback failed — try the track again", item);
      });
      audioRef.current = a;
    }
    return audioRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.removeAttribute("src");
        a.load();
      }
    };
  }, []);

  const play = useCallback(
    async (item: Item, opts?: PlayOptions) => {
      const token = ++playToken.current;
      const startAt = opts?.startAt ?? 0;
      trackRef.current = item;
      loadedId.current = null;
      pendingStart.current = startAt;
      retriedToken.current = -1;
      setTrack(item);
      setCurrentTime(startAt);
      setDuration(item.duration_ms ?? 0);
      setResolving(true);
      clearStall();

      const a = getAudio();
      a.pause();

      try {
        const info = await resolveStream(item.video_id ?? "");
        if (token !== playToken.current) return;
        if (info.hls) {
          fail("Live streams aren't supported yet", item);
          return;
        }
        await startPlayback(a, info.url, startAt, item, token);
      } catch (e) {
        if (token !== playToken.current) return;
        fail(friendlyError(e), item);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getAudio]
  );

  const load = useCallback(
    (item: Item, position: number) => {
      playToken.current++;
      trackRef.current = item;
      loadedId.current = null;
      pendingStart.current = position;
      setTrack(item);
      setCurrentTime(position);
      setDuration(item.duration_ms ?? 0);
      setResolving(false);
      setIsPlaying(false);
      const a = audioRef.current;
      if (a) a.pause();
    },
    []
  );

  const toggle = useCallback(() => {
    const item = trackRef.current;
    if (!item) return;
    const a = getAudio();
    if (loadedId.current !== item.video_id) {
      // Restored session or failed load: resolve lazily, then resume.
      play(item, { startAt: pendingStart.current });
    } else if (a.paused) {
      a.play().catch(() => {});
    } else {
      a.pause();
    }
  }, [getAudio, play]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const replay = useCallback(() => {
    const a = getAudio();
    a.currentTime = 0;
    a.play().catch(() => {});
  }, [getAudio]);

  const getCurrentTime = useCallback(() => {
    const item = trackRef.current;
    const a = audioRef.current;
    if (a && item && loadedId.current === item.video_id) return a.currentTime;
    return pendingStart.current;
  }, []);

  const seek = useCallback(
    (t: number) => {
      const item = trackRef.current;
      if (!item || !isFinite(t)) return;
      const clamped = Math.max(0, t);
      const a = getAudio();
      if (loadedId.current === item.video_id) {
        a.currentTime = clamped;
      } else {
        pendingStart.current = clamped;
      }
      setCurrentTime(clamped);
      setSeekTick((n) => n + 1);
    },
    [getAudio]
  );

  const fadeRef = useRef(1);
  const setFade = useCallback((f: number) => {
    fadeRef.current = Math.min(1, Math.max(0, f));
    if (audioRef.current) audioRef.current.volume = volumeRef.current * fadeRef.current;
  }, []);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    volumeRef.current = clamped;
    setVolumeState(clamped);
    if (audioRef.current) audioRef.current.volume = clamped * fadeRef.current;
    try {
      localStorage.setItem("melodi.volume", String(clamped));
    } catch {
      /* ignore */
    }
  }, []);

  const toggleMute = useCallback(() => {
    if (volumeRef.current > 0) {
      prevVolume.current = volumeRef.current;
      setVolume(0);
    } else {
      setVolume(prevVolume.current || 0.7);
    }
  }, [setVolume]);

  return {
    track,
    isPlaying,
    isLoading: resolving || stalled,
    currentTime,
    duration,
    volume,
    seekTick,
    play,
    load,
    toggle,
    pause,
    replay,
    seek,
    getCurrentTime,
    setVolume,
    toggleMute,
    setFade,
  };
}
