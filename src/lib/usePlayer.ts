import { useCallback, useEffect, useRef, useState } from "react";
import { prepareStream } from "../api";
import type { Item } from "../types";
import { friendlyError } from "./format";
import { audioEngine, type Deck, type EqBands } from "./audioEngine";

export interface PlayerCallbacks {
  /** The song ended — or, with crossfade on, is about to end. */
  onEnded?: () => void;
  /** A track failed to load/play (after any automatic retry). */
  onError?: (message: string, item: Item) => void;
  /** Fires once per play request, when audio actually starts. */
  onStarted?: (item: Item) => void;
}

export interface PlayOptions {
  startAt?: number;
}

export interface AudioOptions {
  /** Seconds of overlap between songs; 0 = off. */
  crossfade: number;
  normalize: boolean;
  eq: EqBands;
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
  setAudioOptions: (o: AudioOptions) => void;
}

/** Songs shorter than this never crossfade (intros, skits). */
const MIN_XFADE_SONG = 45;

export function usePlayer(callbacks: PlayerCallbacks): PlayerApi {
  const engine = audioEngine();
  const active = useRef(0);
  const deck = () => engine.decks[active.current];

  const playToken = useRef(0);
  const trackRef = useRef<Item | null>(null);
  /** video id whose stream is currently loaded in the active deck */
  const loadedId = useRef<string | null>(null);
  /** loudness of the loaded song, for re-applying normalization */
  const loudness = useRef<number | null>(null);
  /** position to resume from when the stream isn't loaded yet */
  const pendingStart = useRef(0);
  const retriedToken = useRef(-1);
  const startedToken = useRef(-1);
  const stallTimer = useRef<number | null>(null);
  const prevVolume = useRef(0.7);
  const cbRef = useRef(callbacks);
  cbRef.current = callbacks;

  const opts = useRef<AudioOptions>({ crossfade: 0, normalize: true, eq: [] });
  /** Token whose song already fired an early onEnded for crossfading. */
  const earlyEnded = useRef(-1);
  /** Set when a crossfade is waiting for the next play() call. */
  const xfadeArmed = useRef<{ token: number; at: number } | null>(null);
  /** Timer that silences the outgoing deck after a crossfade. */
  const xfadeTimer = useRef<number | null>(null);

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

  const stopDeck = (d: Deck) => {
    d.el.pause();
    d.el.removeAttribute("src");
    d.el.load();
    engine.setDeckGain(d, 0);
  };

  /** Stop any song still fading out on the other deck. */
  const cancelXfade = () => {
    xfadeArmed.current = null;
    if (xfadeTimer.current != null) {
      window.clearTimeout(xfadeTimer.current);
      xfadeTimer.current = null;
    }
    const other = engine.decks[1 - active.current];
    if (other.el.getAttribute("src")) stopDeck(other);
    engine.setDeckGain(deck(), deck().norm, 0.05);
  };

  /** Point a deck at a URL and start it, resuming at `startAt`. */
  const startPlayback = async (
    d: Deck,
    url: string,
    startAt: number,
    item: Item,
    token: number,
    fadeIn: number
  ) => {
    d.el.src = url;
    if (startAt > 0) {
      const seekTo = () => {
        if (token === playToken.current) d.el.currentTime = startAt;
      };
      if (d.el.readyState >= 1) seekTo();
      else d.el.addEventListener("loadedmetadata", seekTo, { once: true });
    }
    engine.resume();
    engine.setDeckGain(d, fadeIn > 0 ? 0 : d.norm);
    await d.el.play();
    if (token !== playToken.current) return;
    if (fadeIn > 0) engine.setDeckGain(d, d.norm, fadeIn);
    loadedId.current = item.video_id;
    pendingStart.current = 0;
    setIsPlaying(true);
  };

  // Wire both decks once. Events from the deck that isn't active (a song
  // fading out) are ignored.
  useEffect(() => {
    const offs: (() => void)[] = [];
    engine.decks.forEach((d, i) => {
      const a = d.el;
      const on = <K extends keyof HTMLMediaElementEventMap>(type: K, fn: () => void) => {
        const h = () => {
          if (active.current === i) fn();
        };
        a.addEventListener(type, h);
        offs.push(() => a.removeEventListener(type, h));
      };
      on("timeupdate", () => {
        setCurrentTime(a.currentTime);
        // Crossfade: hand over to the next song a little before the end.
        const x = opts.current.crossfade;
        const token = playToken.current;
        if (
          x > 0 &&
          engine.available &&
          earlyEnded.current !== token &&
          !a.paused &&
          isFinite(a.duration) &&
          a.duration > Math.max(MIN_XFADE_SONG, x * 3) &&
          a.duration - a.currentTime <= x
        ) {
          earlyEnded.current = token;
          xfadeArmed.current = { token, at: performance.now() };
          cbRef.current.onEnded?.();
        }
      });
      const dur = () => {
        if (isFinite(a.duration)) setDuration(a.duration * 1000);
      };
      on("durationchange", dur);
      on("loadedmetadata", dur);
      on("playing", () => {
        setIsPlaying(true);
        setResolving(false);
        clearStall();
        const item = trackRef.current;
        if (item && startedToken.current !== playToken.current) {
          startedToken.current = playToken.current;
          cbRef.current.onStarted?.(item);
        }
      });
      on("pause", () => {
        setIsPlaying(false);
        clearStall();
      });
      on("ended", () => {
        setIsPlaying(false);
        setCurrentTime(0);
        xfadeArmed.current = null;
        // Already handed over early for a crossfade (and nothing followed).
        if (earlyEnded.current === playToken.current) return;
        cbRef.current.onEnded?.();
      });
      on("waiting", () => {
        if (stallTimer.current == null) {
          stallTimer.current = window.setTimeout(() => setStalled(true), 300);
        }
      });
      on("canplay", clearStall);
      on("error", () => {
        const item = trackRef.current;
        const token = playToken.current;
        if (!item || !a.getAttribute("src")) return;

        // The stream may have expired or the proxy couldn't resolve it:
        // re-resolve once (surfacing a readable error) and resume.
        if (retriedToken.current !== token) {
          retriedToken.current = token;
          const resumeAt = a.currentTime || pendingStart.current;
          setResolving(true);
          prepareStream(item.video_id ?? "", true)
            .then((info) => {
              if (token !== playToken.current) return;
              if (info.hls) throw "Live streams aren't supported yet";
              a.removeAttribute("src");
              return startPlayback(d, info.url, resumeAt, item, token, 0);
            })
            .catch((e) => {
              if (token !== playToken.current) return;
              fail(friendlyError(e), item);
            });
          return;
        }
        fail("Playback failed — try the track again", item);
      });
    });
    return () => {
      offs.forEach((f) => f());
      engine.decks.forEach((d) => d.el.pause());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const play = useCallback(async (item: Item, opts2?: PlayOptions) => {
    const token = ++playToken.current;
    const startAt = opts2?.startAt ?? 0;

    // Crossfade if the previous song just handed over and is still playing.
    const armed = xfadeArmed.current;
    const outgoing = deck();
    const x = opts.current.crossfade;
    const crossfading =
      armed != null &&
      startAt === 0 &&
      !outgoing.el.paused &&
      performance.now() - armed.at < (x + 3) * 1000;
    xfadeArmed.current = null;

    if (!crossfading) {
      cancelXfade();
      outgoing.el.pause();
    }

    trackRef.current = item;
    loadedId.current = null;
    pendingStart.current = startAt;
    retriedToken.current = -1;
    setTrack(item);
    setCurrentTime(startAt);
    setDuration(item.duration_ms ?? 0);
    setResolving(true);
    clearStall();

    try {
      const info = await prepareStream(item.video_id ?? "");
      if (token !== playToken.current) return;
      if (info.hls) {
        fail("Live streams aren't supported yet", item);
        return;
      }
      loudness.current = info.loudness_db;

      if (crossfading && !outgoing.el.paused) {
        // Switch decks: the new song fades in while the old one fades out.
        const left = isFinite(outgoing.el.duration) ? outgoing.el.duration - outgoing.el.currentTime : x;
        const secs = Math.max(0.5, Math.min(x, left));
        active.current = 1 - active.current;
        const incoming = deck();
        incoming.norm = engine.normFor(info.loudness_db);
        engine.setDeckGain(outgoing, 0, secs);
        if (xfadeTimer.current != null) window.clearTimeout(xfadeTimer.current);
        xfadeTimer.current = window.setTimeout(() => {
          xfadeTimer.current = null;
          stopDeck(outgoing);
        }, secs * 1000 + 150);
        await startPlayback(incoming, info.url, 0, item, token, secs);
      } else {
        if (crossfading) cancelXfade();
        const d = deck();
        d.norm = engine.normFor(info.loudness_db);
        await startPlayback(d, info.url, startAt, item, token, 0);
      }
    } catch (e) {
      if (token !== playToken.current) return;
      fail(friendlyError(e), item);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback((item: Item, position: number) => {
    playToken.current++;
    trackRef.current = item;
    loadedId.current = null;
    pendingStart.current = position;
    setTrack(item);
    setCurrentTime(position);
    setDuration(item.duration_ms ?? 0);
    setResolving(false);
    setIsPlaying(false);
    cancelXfade();
    deck().el.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = useCallback(() => {
    const item = trackRef.current;
    if (!item) return;
    const a = deck().el;
    if (loadedId.current !== item.video_id) {
      // Restored session or failed load: resolve lazily, then resume.
      play(item, { startAt: pendingStart.current });
    } else if (a.paused) {
      engine.resume();
      a.play().catch(() => {});
    } else {
      cancelXfade();
      a.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play]);

  const pause = useCallback(() => {
    cancelXfade();
    deck().el.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const replay = useCallback(() => {
    const a = deck().el;
    earlyEnded.current = -1;
    a.currentTime = 0;
    engine.resume();
    a.play().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const getCurrentTime = useCallback(() => {
    const item = trackRef.current;
    if (item && loadedId.current === item.video_id) return deck().el.currentTime;
    return pendingStart.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const seek = useCallback((t: number) => {
    const item = trackRef.current;
    if (!item || !isFinite(t)) return;
    const clamped = Math.max(0, t);
    if (loadedId.current === item.video_id) {
      cancelXfade();
      // Seeking back out of the crossfade window allows another handover.
      if (earlyEnded.current === playToken.current) earlyEnded.current = -1;
      deck().el.currentTime = clamped;
    } else {
      pendingStart.current = clamped;
    }
    setCurrentTime(clamped);
    setSeekTick((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setFade = useCallback((f: number) => {
    engine.setFade(Math.min(1, Math.max(0, f)));
  }, [engine]);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, v));
    volumeRef.current = clamped;
    setVolumeState(clamped);
    engine.setVolume(clamped);
    try {
      localStorage.setItem("melodi.volume", String(clamped));
    } catch {
      /* ignore */
    }
  }, [engine]);

  useEffect(() => {
    engine.setVolume(volumeRef.current);
  }, [engine]);

  const setAudioOptions = useCallback((o: AudioOptions) => {
    opts.current = o;
    engine.setEq(o.eq);
    engine.setNormalize(o.normalize);
    // Re-apply normalization to the song that's playing now.
    const d = deck();
    d.norm = engine.normFor(loudness.current);
    if (!xfadeTimer.current) engine.setDeckGain(d, d.norm, 0.3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine]);

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
    setAudioOptions,
  };
}
