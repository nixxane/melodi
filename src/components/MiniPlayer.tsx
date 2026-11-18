import { useEffect } from "react";
import type { PlayerApi } from "../lib/usePlayer";
import { artistLabel, formatTime } from "../lib/format";
import { Art } from "./Art";
import { Spinner } from "./Spinner";

interface Props {
  player: PlayerApi;
  canNext: boolean;
  canPrev: boolean;
  onNext: () => void;
  onPrev: () => void;
  onExpand: () => void;
  sleepLabel: string | null;
}

const CELLS = 22;

/** Compact always-on-top player. Drag anywhere on the background to move it. */
export function MiniPlayer({ player, canNext, canPrev, onNext, onPrev, onExpand, sleepLabel }: Props) {
  const { track, isPlaying, isLoading, currentTime } = player;
  const dur = (player.duration || track?.duration_ms || 0) / 1000;
  const filled = dur > 0 ? Math.min(CELLS, Math.round((currentTime / dur) * CELLS)) : 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExpand();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExpand]);

  const seekFromBar = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (dur <= 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    player.seek(((e.clientX - r.left) / r.width) * dur);
  };

  return (
    <div className="mini" data-tauri-drag-region>
      <button className="mini-art" onDoubleClick={onExpand} title="Double-click to expand" tabIndex={-1}>
        <Art thumbnails={track?.thumbnails} size={160} eager />
      </button>

      <div className="mini-body" data-tauri-drag-region>
        <div className="mini-top" data-tauri-drag-region>
          <div className="mini-text" data-tauri-drag-region>
            <div className="mini-title" title={track?.title} data-tauri-drag-region>
              {track?.title ?? "nothing playing"}
            </div>
            <div className="mini-artist" data-tauri-drag-region>
              {track ? artistLabel(track) : "melodi"}
              {sleepLabel ? <span className="mini-sleep"> · zz {sleepLabel}</span> : null}
            </div>
          </div>
          <button className="kbtn mini-expand" onClick={onExpand} title="Back to the full window (Esc)">
            ⤢
          </button>
        </div>

        <div className="mini-controls">
          <button className="kbtn" onClick={onPrev} disabled={!track || (!canPrev && currentTime <= 3)} aria-label="Previous">
            |◀
          </button>
          <button className="kbtn play" onClick={player.toggle} disabled={!track} aria-label={isPlaying ? "Pause" : "Play"}>
            {isLoading ? <Spinner /> : isPlaying ? "❚❚" : "▶"}
          </button>
          <button className="kbtn" onClick={onNext} disabled={!canNext} aria-label="Next">
            ▶|
          </button>
          <button className="mini-bar" onClick={seekFromBar} disabled={!track} aria-label="Seek" tabIndex={-1}>
            <span className="fill">{"━".repeat(filled)}</span>
            <span className="rest">{"─".repeat(CELLS - filled)}</span>
          </button>
          <span className="mini-time">{formatTime(currentTime * 1000)}</span>
        </div>
      </div>
    </div>
  );
}
