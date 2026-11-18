import { useEffect, useRef } from "react";
import type { PlayerApi } from "./usePlayer";
import { artistLabel, pickThumb } from "./format";

export interface MediaHandlers {
  next: () => void;
  prev: () => void;
}

const ACTIONS: MediaSessionAction[] = [
  "play",
  "pause",
  "previoustrack",
  "nexttrack",
  "seekto",
  "seekbackward",
  "seekforward",
];

/** Exposes now-playing info and media-key actions to the OS (SMTC on Windows). */
export function useMediaSession(player: PlayerApi, handlers: MediaHandlers) {
  const playerRef = useRef(player);
  playerRef.current = player;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const { track, isPlaying, duration, seekTick } = player;

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const p = () => playerRef.current;
    const set = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        /* unsupported action */
      }
    };
    set("play", () => {
      if (!p().isPlaying) p().toggle();
    });
    set("pause", () => p().pause());
    set("previoustrack", () => handlersRef.current.prev());
    set("nexttrack", () => handlersRef.current.next());
    set("seekto", (d) => {
      if (d.seekTime != null) p().seek(d.seekTime);
    });
    set("seekbackward", (d) => p().seek(p().getCurrentTime() - (d.seekOffset ?? 10)));
    set("seekforward", (d) => p().seek(p().getCurrentTime() + (d.seekOffset ?? 10)));
    return () => ACTIONS.forEach((a) => set(a, null));
  }, []);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    if (!track) {
      ms.metadata = null;
      return;
    }
    const art = pickThumb(track, 512);
    ms.metadata = new MediaMetadata({
      title: track.title,
      artist: artistLabel(track),
      artwork: art ? [{ src: art, sizes: "512x512" }] : [],
    });
  }, [track]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = track ? (isPlaying ? "playing" : "paused") : "none";
  }, [track, isPlaying]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !track) return;
    const d = duration / 1000;
    if (!isFinite(d) || d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        playbackRate: 1,
        position: Math.min(d, Math.max(0, playerRef.current.getCurrentTime())),
      });
    } catch {
      /* ignore invalid state */
    }
  }, [track, isPlaying, duration, seekTick]);
}
