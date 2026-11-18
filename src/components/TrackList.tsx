import { useRef, useState } from "react";
import type { Item } from "../types";
import { artistLabel, formatTime } from "../lib/format";
import { Art } from "./Art";
import { useActions } from "../lib/actions";
import { songMenu } from "./Card";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import type { MenuItem } from "./ContextMenu";
import { Spinner } from "./Spinner";

interface Props {
  items: Item[];
  onPlay: (item: Item, index: number) => void;
  currentVideoId?: string | null;
  loadingVideoId?: string | null;
  isPlaying?: boolean;
  onPlayNext?: (item: Item, index: number) => void;
  onAddToQueue?: (item: Item, index: number) => void;
  onRemove?: (item: Item, index: number) => void;
  onReorder?: (from: number, to: number) => void;
  /** Label for the remove action (default: "remove from queue"). */
  removeLabel?: string;
  /** Added to the displayed row number (for partial lists). */
  indexBase?: number;
  dim?: boolean;
  /** Show the column header row. */
  header?: boolean;
  /** Show artwork thumbnails (off for album pages, where they're all the same). */
  thumbs?: boolean;
  /** Draw a labelled divider before the row at this index. */
  dividerAt?: number;
  dividerLabel?: string;
}

export function TrackList({
  items,
  onPlay,
  currentVideoId,
  loadingVideoId,
  isPlaying = true,
  onPlayNext,
  onAddToQueue,
  onRemove,
  onReorder,
  removeLabel = "remove from queue",
  indexBase = 0,
  dim,
  header = true,
  thumbs = true,
  dividerAt,
  dividerLabel,
}: Props) {
  const ctx = useContextMenu();
  const actions = useActions();
  const dragFrom = useRef<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const width = String(items.length + indexBase).length;

  const menuFor = (item: Item, i: number): MenuItem[] => {
    const m = songMenu(item, () => onPlay(item, i), actions);
    if (onPlayNext) m[1] = { label: "play next", onClick: () => onPlayNext(item, i) };
    if (onAddToQueue) m[2] = { label: "add to queue", onClick: () => onAddToQueue(item, i) };
    if (onRemove) m.push({ label: removeLabel, danger: true, onClick: () => onRemove(item, i) });
    return m;
  };

  const action = (label: string, title: string, fn: () => void, danger = false) => (
    <button
      className={`row-btn ${danger ? "danger" : ""}`}
      title={title}
      aria-label={title}
      tabIndex={-1}
      onClick={(e) => {
        e.stopPropagation();
        fn();
      }}
    >
      {label}
    </button>
  );

  return (
    <div className={`tracklist ${dim ? "dim" : ""} ${thumbs ? "with-thumbs" : ""}`}>
      {header ? (
        <div className="track-head" aria-hidden="true">
          <span className="idx">#</span>
          {thumbs ? <span /> : null}
          <span className="col-title">title</span>
          <span className="col-artist">artist</span>
          <span className="row-actions" />
          <span className="track-duration">time</span>
        </div>
      ) : null}
      {items.map((item, i) => {
        const isCurrent = item.video_id != null && item.video_id === currentVideoId;
        const isLoading = item.video_id != null && item.video_id === loadingVideoId;
        const draggable = !!onReorder && !isCurrent;
        const num = String(i + 1 + indexBase).padStart(width, "0");

        return (
          <div key={item.video_id ?? `${item.kind}-${item.title}-${i}`}>
            {dividerAt === i && dividerLabel ? (
              <div className="list-divider">
                <span>{dividerLabel}</span>
              </div>
            ) : null}
            <div
              className={`track-row nav-target ${isCurrent ? "playing" : ""} ${
                isCurrent && !isPlaying ? "paused" : ""
              } ${overIndex === i ? "drop-target" : ""}`}
              tabIndex={0}
              role="button"
              aria-label={`Play ${item.title} by ${artistLabel(item)}`}
              onClick={() => onPlay(item, i)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  onPlay(item, i);
                }
              }}
              onContextMenu={(e) => ctx.open(e, menuFor(item, i))}
              draggable={draggable}
              onDragStart={(e) => {
                dragFrom.current = i;
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(i));
              }}
              onDragOver={(e) => {
                if (dragFrom.current == null || !onReorder) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (overIndex !== i) setOverIndex(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragFrom.current;
                dragFrom.current = null;
                setOverIndex(null);
                if (from != null && onReorder && from !== i) onReorder(from, i);
              }}
              onDragEnd={() => {
                dragFrom.current = null;
                setOverIndex(null);
              }}
            >
              <span className="idx">
                {isLoading ? (
                  <Spinner />
                ) : isCurrent ? (
                  <span className="eq">
                    <span />
                    <span />
                    <span />
                  </span>
                ) : (
                  <>
                    <span className="idx-num">{num}</span>
                    <span className="idx-play">▶</span>
                  </>
                )}
              </span>
              {thumbs ? (
                <span className="row-thumb">
                  <Art thumbnails={item.thumbnails} size={64} eager={i < 15} />
                </span>
              ) : null}
              <span className="col-title" title={item.title}>
                {actions.isLiked(item.video_id) ? <span className="liked-mark" aria-label="liked">♥︎</span> : null}
                {item.title}
                {item.explicit ? <span className="e-badge">E</span> : null}
              </span>
              <span className="col-artist" title={artistLabel(item)}>
                {item.artist_id ? (
                  <button
                    className="link"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      actions.openArtist(item.artist_id!, item.artists[0] ?? artistLabel(item));
                    }}
                  >
                    {artistLabel(item)}
                  </button>
                ) : (
                  artistLabel(item)
                )}
              </span>
              <span className="row-actions">
                {onPlayNext ? action("+next", "Play next", () => onPlayNext(item, i)) : null}
                {onAddToQueue ? action("+q", "Add to queue", () => onAddToQueue(item, i)) : null}
                {action(
                  actions.isLiked(item.video_id) ? "♥︎" : "♡",
                  actions.isLiked(item.video_id) ? "Unlike" : "Like",
                  () => actions.toggleLike(item)
                )}
                {action("+pl", "Add to playlist", () => actions.addToPlaylist([item]))}
                {action("≈", "Start radio", () => actions.startRadio(item))}
                {onRemove && !isCurrent
                  ? action("del", removeLabel, () => onRemove(item, i), true)
                  : null}
              </span>
              <span className="track-duration">
                {item.duration_ms != null ? formatTime(item.duration_ms) : "--:--"}
              </span>
            </div>
          </div>
        );
      })}
      <ContextMenu menu={ctx.menu} onClose={ctx.close} />
    </div>
  );
}
