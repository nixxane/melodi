import { useCallback, useEffect, useRef, useState } from "react";
import type { PlayerApi } from "./usePlayer";

/** Fade out over the last few seconds before pausing. */
const FADE_SECS = 20;

export type SleepMode = { kind: "minutes"; minutes: number; endsAt: number } | { kind: "track"; videoId: string };

const STEPS: (number | "track" | null)[] = [15, 30, 45, 60, "track", null];

/**
 * Sleep timer: pause after N minutes or at the end of the current song,
 * fading out gently first. Pauses (doesn't quit), so the queue is kept.
 */
export function useSleepTimer(player: PlayerApi, notify: (msg: string) => void) {
  const [mode, setMode] = useState<SleepMode | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null); // seconds
  const playerRef = useRef(player);
  playerRef.current = player;

  const stop = useCallback(() => {
    setMode(null);
    setRemaining(null);
    playerRef.current.setFade(1);
  }, []);

  /** Off → 15 → 30 → 45 → 60 min → end of song → off. */
  const cycle = useCallback(() => {
    setMode((m) => {
      const cur = m == null ? null : m.kind === "track" ? "track" : m.minutes;
      const next = STEPS[(STEPS.indexOf(cur) + 1) % STEPS.length];
      playerRef.current.setFade(1);
      if (next === null) {
        notify("Sleep timer off");
        setRemaining(null);
        return null;
      }
      if (next === "track") {
        const id = playerRef.current.track?.video_id;
        if (!id) {
          notify("Sleep timer off");
          return null;
        }
        notify("Sleep timer: end of this song");
        return { kind: "track", videoId: id };
      }
      notify(`Sleep timer: ${next} min`);
      return { kind: "minutes", minutes: next, endsAt: Date.now() + next * 60_000 };
    });
  }, [notify]);

  useEffect(() => {
    if (!mode) return;
    const tick = () => {
      const p = playerRef.current;
      let left: number;
      if (mode.kind === "minutes") {
        left = (mode.endsAt - Date.now()) / 1000;
      } else {
        // The song changed (skipped / ended): stop right here.
        if (p.track?.video_id !== mode.videoId) {
          p.pause();
          notify("Sleep timer: paused");
          stop();
          return;
        }
        const dur = (p.duration || p.track?.duration_ms || 0) / 1000;
        left = dur > 0 ? dur - p.getCurrentTime() : Infinity;
      }
      setRemaining(Number.isFinite(left) ? Math.max(0, left) : null);
      if (left <= 0.4) {
        p.pause();
        notify("Sleep timer: paused · good night");
        stop();
      } else if (left <= FADE_SECS && p.isPlaying) {
        p.setFade(left / FADE_SECS);
      } else {
        p.setFade(1);
      }
    };
    tick();
    const t = window.setInterval(tick, 250);
    return () => window.clearInterval(t);
  }, [mode, notify, stop]);

  const label =
    mode == null
      ? null
      : mode.kind === "track"
        ? "end of song"
        : remaining == null
          ? `${mode.minutes}m`
          : remaining >= 60
            ? `${Math.ceil(remaining / 60)}m`
            : `${Math.ceil(remaining)}s`;

  return { mode, remaining, label, cycle, stop };
}
