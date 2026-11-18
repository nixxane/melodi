import { useEffect, useRef, useState } from "react";
import type { PlayerApi } from "../lib/usePlayer";
import type { RepeatMode } from "../types";
import { artistLabel, formatTime, pickThumb } from "../lib/format";
import { Spinner } from "./Spinner";
import { useActions } from "../lib/actions";

interface Props {
  player: PlayerApi;
  shuffle: boolean;
  repeat: RepeatMode;
  canNext: boolean;
  canPrev: boolean;
  onShuffle: () => void;
  onRepeat: () => void;
  onNext: () => void;
  onPrev: () => void;
  onOpenQueue: () => void;
  lyricsOpen: boolean;
  onLyrics: () => void;
}

/** How many monospace character cells fit in an element's width. */
function useCols(ref: React.RefObject<HTMLElement>) {
  const [cols, setCols] = useState(40);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(20);
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
    el.appendChild(probe);
    const measure = () => {
      const cw = probe.getBoundingClientRect().width / 20 || 8;
      setCols(Math.max(4, Math.floor(el.clientWidth / cw)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Webfont may load after first measure.
    document.fonts?.ready.then(measure).catch(() => {});
    return () => {
      ro.disconnect();
      probe.remove();
    };
  }, [ref]);
  return cols;
}

const VOL_CELLS = 10;

export function PlayerBar({
  player,
  shuffle,
  repeat,
  canNext,
  canPrev,
  onShuffle,
  onRepeat,
  onNext,
  onPrev,
  onOpenQueue,
  lyricsOpen,
  onLyrics,
}: Props) {
  const actions = useActions();
  const { track, isPlaying, isLoading, currentTime, volume } = player;
  const thumb = track ? pickThumb(track, 192) : null;
  const effectiveDuration = player.duration || track?.duration_ms || 0;
  const known = effectiveDuration > 0;
  const maxSec = Math.max(1, effectiveDuration / 1000);

  // Seek: show the drag position locally, only seek on release.
  const [drag, setDrag] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const dragging = useRef(false);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);

  const shown = drag ?? currentTime;
  const frac = known ? Math.min(1, Math.max(0, shown / maxSec)) : 0;

  const seekRef = useRef<HTMLDivElement>(null);
  const cols = useCols(seekRef);
  const filled = track ? Math.min(cols - 1, Math.round(frac * (cols - 1))) : 0;

  const finishDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;
    const v = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (v != null) player.seek(v);
  };

  const barRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const apply = () =>
      document.documentElement.style.setProperty("--playerbar-h", `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const prevEnabled = !!track && (canPrev || currentTime > 3);
  const repeatLabel =
    repeat === "off" ? "Repeat: off" : repeat === "all" ? "Repeat: all" : "Repeat: one";
  const volCells = Math.round(volume * VOL_CELLS);
  const panelTitle = !track ? "idle" : isLoading ? "loading" : isPlaying ? "playing" : "paused";

  return (
    <footer className="playerbar panel" ref={barRef}>
      <span className="panel-title">
        {isPlaying ? "▶" : track ? "❚❚" : "■"} {panelTitle}
      </span>

      <div className="now-playing">
        <div className="now-thumb">
          {thumb ? <img src={thumb} alt="" draggable={false} /> : <span>♪</span>}
        </div>
        <div className="now-meta">
          <div className="now-title" title={track?.title}>
            {track?.title ?? "nothing playing"}
          </div>
          <div className="now-artist" title={track ? artistLabel(track) : undefined}>
            {track?.artist_id ? (
              <button
                className="link"
                onClick={() => actions.openArtist(track.artist_id!, track.artists[0] ?? artistLabel(track))}
              >
                {artistLabel(track)}
              </button>
            ) : track ? (
              artistLabel(track)
            ) : (
              "pick a track to start listening"
            )}
          </div>
        </div>
      </div>

      <div className="player-center">
        <div className="transport">
          <button
            className={`kbtn ${shuffle ? "on" : ""}`}
            onClick={onShuffle}
            aria-label="Shuffle"
            aria-pressed={shuffle}
            title={shuffle ? "Shuffle: on" : "Shuffle: off"}
          >
            shuf
          </button>
          <button
            className="kbtn"
            onClick={onPrev}
            disabled={!prevEnabled}
            aria-label="Previous"
            title="Previous (Shift+←)"
          >
            |◀
          </button>
          <button
            className="kbtn play"
            onClick={player.toggle}
            disabled={!track}
            aria-label={isPlaying ? "Pause" : "Play"}
            title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          >
            {isLoading ? <Spinner /> : isPlaying ? "❚❚" : "▶"}
            <span className="play-label">{isLoading ? "load" : isPlaying ? "pause" : "play"}</span>
          </button>
          <button
            className="kbtn"
            onClick={onNext}
            disabled={!canNext}
            aria-label="Next"
            title="Next (Shift+→)"
          >
            ▶|
          </button>
          <button
            className={`kbtn ${repeat !== "off" ? "on" : ""}`}
            onClick={onRepeat}
            aria-label={repeatLabel}
            aria-pressed={repeat !== "off"}
            title={repeatLabel}
          >
            {repeat === "one" ? "rep1" : "rep"}
          </button>
        </div>

        <div className="seek">
          <span className="seek-time">{formatTime(shown * 1000)}</span>
          <div className="ascii-range seek-track" ref={seekRef}>
            <div className="ascii-bar" aria-hidden="true">
              <span className="fill">{"━".repeat(filled)}</span>
              <span className="head">{track ? "●" : "─"}</span>
              <span className="rest">{"─".repeat(Math.max(0, cols - filled - 1))}</span>
            </div>
            {hover ? (
              <div className="seek-tip" style={{ left: hover.x }}>
                {formatTime(hover.t * 1000)}
              </div>
            ) : null}
            <input
              type="range"
              min={0}
              max={maxSec}
              step={0.1}
              value={Math.min(shown, maxSec)}
              disabled={!track}
              aria-label="Seek"
              onPointerDown={() => {
                dragging.current = true;
                window.addEventListener(
                  "pointerup",
                  () => {
                    finishDrag();
                    (document.activeElement as HTMLElement | null)?.blur?.();
                  },
                  { once: true }
                );
              }}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (dragging.current) {
                  dragRef.current = v;
                  setDrag(v);
                } else {
                  player.seek(v); // keyboard
                }
              }}
              onPointerMove={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
                setHover({ x: f * r.width, t: f * maxSec });
              }}
              onPointerLeave={() => setHover(null)}
            />
          </div>
          <span className="seek-time">{known ? formatTime(effectiveDuration) : "--:--"}</span>
        </div>
      </div>

      <div className="player-right">
        <div
          className="vol"
          onWheel={(e) => player.setVolume(volume + (e.deltaY < 0 ? 0.05 : -0.05))}
        >
          <button
            className="kbtn bare"
            onClick={player.toggleMute}
            aria-label={volume === 0 ? "Unmute" : "Mute"}
            title={volume === 0 ? "Unmute (M)" : "Mute (M)"}
          >
            {volume === 0 ? "mute" : "vol"}
          </button>
          <div className="ascii-range vol-track">
            <div className="ascii-bar" aria-hidden="true">
              <span className="fill">{"█".repeat(volCells)}</span>
              <span className="rest">{"░".repeat(VOL_CELLS - volCells)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              aria-label="Volume"
              onChange={(e) => player.setVolume(Number(e.target.value))}
              onPointerUp={(e) => e.currentTarget.blur()}
            />
          </div>
          <span className="vol-pct">{String(Math.round(volume * 100)).padStart(3, " ")}%</span>
        </div>
        <div className="player-tools">
          <button
            className="kbtn"
            disabled={!track}
            onClick={() => track && actions.startRadio(track)}
            title="Start radio from this song"
          >
            ≈ radio
          </button>
          <button
            className="kbtn"
            disabled={!track}
            onClick={() => track && actions.addToPlaylist([track])}
            title="Add to playlist"
          >
            +pl
          </button>
          <button
            className={`kbtn ${lyricsOpen ? "on" : ""}`}
            disabled={!track}
            onClick={onLyrics}
            aria-pressed={lyricsOpen}
            title="Lyrics (L)"
          >
            lyrics
          </button>
          <button className="kbtn" onClick={onOpenQueue} aria-label="Open queue" title="Queue (3)">
            queue
          </button>
        </div>
      </div>
    </footer>
  );
}
