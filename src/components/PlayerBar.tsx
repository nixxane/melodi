import { useEffect, useRef, useState } from "react";
import type { PlayerApi } from "../lib/usePlayer";
import type { RepeatMode } from "../types";
import { artistLabel, formatTime } from "../lib/format";
import { Art } from "./Art";
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
  /** Sleep timer label (e.g. "23m"), or null when off. */
  sleepLabel: string | null;
  onSleep: () => void;
  /** Absent where there's no mini player (the web). */
  onMini?: () => void;
  /** Phone layout: a compact bar that opens a full-screen "now playing". */
  phone?: boolean;
  expanded?: boolean;
  onExpand?: () => void;
  onCollapse?: () => void;
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
  sleepLabel,
  onSleep,
  onMini,
  onLyrics,
  phone = false,
  expanded = false,
  onExpand,
  onCollapse,
}: Props) {
  const actions = useActions();
  const { track, isPlaying, isLoading, currentTime, volume, isLive } = player;
  const effectiveDuration = isLive ? 0 : player.duration || track?.duration_ms || 0;
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
  // Live: the bar always sits at the live edge.
  const filled = !track ? 0 : isLive ? cols - 1 : Math.min(cols - 1, Math.round(frac * (cols - 1)));

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
  const panelTitle = !track
    ? "idle"
    : isLoading
      ? "loading"
      : isPlaying
        ? isLive ? "live" : "playing"
        : "paused";

  return (
    <footer className={`playerbar panel ${phone ? "phone" : ""} ${expanded ? "expanded" : ""}`} ref={barRef}>
      <span className="panel-title">
        {isPlaying ? "▶" : track ? "❚❚" : "■"} {panelTitle}
      </span>
      {phone && expanded ? (
        <button className="kbtn np-close" onClick={onCollapse} aria-label="Close now playing">
          ▾ close
        </button>
      ) : null}
      {phone && !expanded && track ? (
        <div className="mini-progress" aria-hidden="true">
          <span style={{ width: `${isLive ? 100 : frac * 100}%` }} />
        </div>
      ) : null}

      <div
        className="now-playing"
        onClick={phone && !expanded && track ? onExpand : undefined}
        role={phone && !expanded && track ? "button" : undefined}
        aria-label={phone && !expanded && track ? "Open now playing" : undefined}
      >
        <div className="now-thumb">
          <Art thumbnails={track?.thumbnails} size={192} eager />
        </div>
        <div className="now-meta">
          <div className="now-title-row">
            <div className="now-title" title={track?.title}>
              {track?.title ?? "nothing playing"}
            </div>
            {track ? (
              <button
                className={`like-btn ${actions.isLiked(track.video_id) ? "on" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.toggleLike(track);
                }}
                aria-pressed={actions.isLiked(track.video_id)}
                aria-label={actions.isLiked(track.video_id) ? "Unlike" : "Like"}
                title={actions.isLiked(track.video_id) ? "Unlike (F)" : "Like (F)"}
              >
                {actions.isLiked(track.video_id) ? "♥︎" : "♡"}
              </button>
            ) : null}
          </div>
          <div className="now-artist" title={track ? artistLabel(track) : undefined}>
            {track?.artist_id ? (
              <button
                className="link"
                onClick={(e) => {
                  if (phone && !expanded) return; // the whole bar opens "now playing"
                  e.stopPropagation();
                  onCollapse?.();
                  actions.openArtist(track.artist_id!, track.artists[0] ?? artistLabel(track));
                }}
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
            className={`kbtn shuf-btn ${shuffle ? "on" : ""}`}
            onClick={onShuffle}
            aria-label="Shuffle"
            aria-pressed={shuffle}
            title={shuffle ? "Shuffle: on" : "Shuffle: off"}
          >
            shuf
          </button>
          <button
            className="kbtn prev-btn"
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
            className="kbtn next-btn"
            onClick={onNext}
            disabled={!canNext}
            aria-label="Next"
            title="Next (Shift+→)"
          >
            ▶|
          </button>
          <button
            className={`kbtn rep-btn ${repeat !== "off" ? "on" : ""}`}
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
          <div className={`ascii-range seek-track ${isLive ? "live" : ""}`} ref={seekRef}>
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
              disabled={!track || isLive}
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
          {isLive ? (
            <span className="seek-time live-badge" title="Live broadcast: pausing and playing again jumps back to live">
              ● live
            </span>
          ) : (
            <span className="seek-time">{known ? formatTime(effectiveDuration) : "--:--"}</span>
          )}
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
            className={`kbtn ${sleepLabel ? "on" : ""}`}
            onClick={onSleep}
            aria-pressed={!!sleepLabel}
            title="Sleep timer (Z): 15 / 30 / 45 / 60 min, end of song, off"
          >
            zz{sleepLabel ? ` ${sleepLabel}` : ""}
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
          {onMini && (
            <button className="kbtn" onClick={onMini} title="Mini player: small, always on top">
              mini
            </button>
          )}
          <button className="kbtn" onClick={onOpenQueue} aria-label="Open queue" title="Queue (3)">
            queue
          </button>
        </div>
      </div>
    </footer>
  );
}
