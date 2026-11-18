import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PlayerApi } from "./usePlayer";
import { pickThumb } from "./format";
import { loadJSON, saveJSON } from "./storage";

const KEY = "melodi.discord";

/**
 * Mirrors playback to Discord as "Listening to <artist>". The backend
 * coalesces and rate-limits updates, so it's fine to call on every change.
 */
export function useDiscordPresence(player: PlayerApi) {
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabledState] = useState<boolean>(() => loadJSON<unknown>(KEY, true) !== false);

  useEffect(() => {
    invoke<boolean>("discord_available")
      .then(setAvailable)
      .catch(() => setAvailable(false));
  }, []);

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on);
    saveJSON(KEY, on);
  }, []);

  const { track, isPlaying, isLoading, duration, seekTick } = player;
  const active = available && enabled && !!track && isPlaying && !isLoading;

  useEffect(() => {
    if (!available) return;
    const send = (presence: unknown) => invoke("discord_presence", { presence }).catch(() => {});
    if (!active || !track) {
      send(null);
      return;
    }
    send({
      title: track.title,
      artist: track.artists.length ? track.artists.join(", ") : track.subtitle || "Unknown artist",
      album: null,
      image: pickThumb(track, 512),
      video_id: track.video_id,
      position_ms: Math.round(player.getCurrentTime() * 1000),
      duration_ms: Math.round(duration || track.duration_ms || 0) || null,
    });
    // Position is read at send time; seeks bump seekTick to resend.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, active, track?.video_id, seekTick, Math.round(duration / 1000)]);

  // Clear the card when the app closes.
  useEffect(() => {
    if (!available) return;
    const clear = () => invoke("discord_presence", { presence: null }).catch(() => {});
    window.addEventListener("beforeunload", clear);
    return () => window.removeEventListener("beforeunload", clear);
  }, [available]);

  return { available, enabled, setEnabled };
}
