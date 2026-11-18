import type { Item } from "../types";
import { artistLabel, pickThumb } from "../lib/format";
import { Card } from "./Card";
import { ShelfRow } from "./ShelfRow";
import { TrackList } from "./TrackList";
import { useActions } from "../lib/actions";
import { Spinner } from "./Spinner";

interface Props {
  query: string;
  searching: boolean;
  hasSearched: boolean;
  results: Item[];
  history: string[];
  onPickHistory: (q: string) => void;
  onClearHistory: () => void;
  onPlayList: (songs: Item[], index: number) => void;
  onPlayNext: (item: Item) => void;
  onAddToQueue: (item: Item) => void;
  currentVideoId?: string | null;
  loadingVideoId?: string | null;
  isPlaying?: boolean;
}

function RowSkeletons({ query }: { query: string }) {
  return (
    <div aria-busy="true" aria-label="Searching">
      <div className="term-line">
        <Spinner /> searching “{query.trim()}”…
      </div>
      <div className="tracklist">
        {Array.from({ length: 8 }, (_, i) => (
          <div className="track-row skeleton-row" key={i} aria-hidden="true">
            <span className="idx" />
            <span className="col-title">
              <span className="skeleton skeleton-line" style={{ width: `${45 + ((i * 13) % 40)}%` }} />
            </span>
            <span className="col-artist">
              <span className="skeleton skeleton-line" style={{ width: "50%" }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TopResult({
  item,
  onPlay,
}: {
  item: Item;
  onPlay: () => void;
}) {
  const actions = useActions();
  const isSong = item.kind === "song" && !!item.video_id;
  const thumb = pickThumb(item, 360);
  const activate = () => (isSong ? onPlay() : actions.open(item));
  return (
    <div
      className="top-result nav-target"
      tabIndex={0}
      role="button"
      aria-label={`${isSong ? "Play" : "Open"} top result ${item.title}`}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          activate();
        }
      }}
    >
      <div className={`top-art ${item.kind === "artist" ? "round" : ""}`}>
        {thumb ? <img src={thumb} alt="" draggable={false} /> : "♪"}
      </div>
      <div className="top-meta">
        <span className="badge inline">{item.kind}</span>
        <div className="top-title" title={item.title}>
          {item.title}
        </div>
        <div className="top-sub">{isSong ? artistLabel(item) : item.subtitle}</div>
      </div>
      <div className="top-play">{isSong ? "⏎ play" : "⏎ open"}</div>
    </div>
  );
}

export function SearchView({
  query,
  searching,
  hasSearched,
  results,
  history,
  onPickHistory,
  onClearHistory,
  onPlayList,
  onPlayNext,
  onAddToQueue,
  currentVideoId,
  loadingVideoId,
  isPlaying,
}: Props) {
  if (!hasSearched || query.trim() === "") {
    return (
      <div className="state">
        <span className="state-art">[ search ]</span>
        <span>type to search songs, artists, albums — esc to clear</span>
        {history.length > 0 ? (
          <div className="recent">
            <div className="recent-head">
              <span>recent</span>
              <button className="row-btn" onClick={onClearHistory}>
                clear
              </button>
            </div>
            <div className="chips">
              {history.map((h) => (
                <button className="chip" key={h} onClick={() => onPickHistory(h)}>
                  <span className="chip-prompt">$</span> {h}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  if (searching) return <RowSkeletons query={query} />;

  const songs = results.filter((r) => r.kind === "song" && r.video_id);
  const top = results[0];
  const others = results.filter((r) => r.kind !== "song" && r !== top);
  // Don't repeat the top result in the Songs list.
  const listed = top?.kind === "song" ? songs.filter((s) => s !== top) : songs;

  if (results.length === 0) {
    return (
      <div className="state">
        <span className="state-art">[ 0 results ]</span>
        <span>nothing matched “{query}”.</span>
      </div>
    );
  }

  return (
    <div className="fade-in">
      {top ? (
        <section className="search-section">
          <h2 className="view-title">top result</h2>
          <TopResult
            item={top}
            onPlay={() =>
              onPlayList(
                songs,
                songs.findIndex((s) => s.video_id === top.video_id)
              )
            }
          />
        </section>
      ) : null}

      {listed.length > 0 ? (
        <section className="search-section">
          <div className="view-header">
            <h2 className="view-title">songs <span className="count">{listed.length}</span></h2>
            <button className="kbtn" onClick={() => onPlayList(songs, 0)} aria-label="Play all songs">
              ▶ play all
            </button>
          </div>
          <TrackList
            items={listed}
            onPlay={(_, i) => onPlayList(listed, i)}
            onPlayNext={onPlayNext}
            onAddToQueue={onAddToQueue}
            currentVideoId={currentVideoId}
            loadingVideoId={loadingVideoId}
            isPlaying={isPlaying}
          />
        </section>
      ) : null}

      {others.length > 0 ? (
        <section className="search-section">
          <h2 className="view-title">albums · artists · playlists</h2>
          <ShelfRow>
            {others.map((item, i) => (
              <Card
                key={`${item.kind}-${item.browse_id ?? item.title}-${i}`}
                item={item}
                onPlay={(it) => onPlayList([it], 0)}
              />
            ))}
          </ShelfRow>
        </section>
      ) : null}
    </div>
  );
}

export function ClearSearchButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="search-clear" onClick={onClick} aria-label="Clear search" title="Clear">
      esc
    </button>
  );
}
