import type { Item } from "../types";
import { formatTime } from "../lib/format";
import { useActions } from "../lib/actions";
import { TrackList } from "./TrackList";

interface Props {
  likes: Item[];
  onPlayList: (items: Item[], index: number) => void;
  onUnlike: (videoId: string) => void;
  currentVideoId: string | null;
  loadingVideoId: string | null;
  isPlaying: boolean;
}

/** All liked songs, newest first. */
export function LikedView({ likes, onPlayList, onUnlike, currentVideoId, loadingVideoId, isPlaying }: Props) {
  const actions = useActions();
  const total = likes.reduce((s, i) => s + (i.duration_ms ?? 0), 0);

  return (
    <div className="fade-in">
      <header className="page-header">
        <div className="page-art liked-art" aria-hidden="true">
          ♥︎
        </div>
        <div className="page-meta">
          <span className="badge">collection</span>
          <h1 className="page-title">liked songs</h1>
          <div className="page-sub dim">
            {likes.length} {likes.length === 1 ? "song" : "songs"}
            {total ? ` • ${formatTime(total)}` : ""}
          </div>
          <div className="page-actions">
            <button className="kbtn play-btn" disabled={!likes.length} onClick={() => onPlayList(likes, 0)}>
              ▶ play
            </button>
            <button
              className="kbtn"
              disabled={likes.length < 2}
              onClick={() => onPlayList([...likes].sort(() => Math.random() - 0.5), 0)}
            >
              shuffle
            </button>
            {likes.length ? (
              <button
                className="kbtn"
                onClick={() => actions.startRadio(likes[Math.floor(Math.random() * Math.min(10, likes.length))])}
                title="Radio based on one of your recent likes"
              >
                ≈ radio
              </button>
            ) : null}
            <button className="kbtn" disabled={!likes.length} onClick={() => actions.addToPlaylist(likes)}>
              + save
            </button>
          </div>
        </div>
      </header>

      {likes.length === 0 ? (
        <div className="state">
          <span className="state-art">[ no likes yet ]</span>
          <span>press f on a playing song, or the ♡ on any row.</span>
        </div>
      ) : (
        <TrackList
          items={likes}
          onPlay={(_, i) => onPlayList(likes, i)}
          onPlayNext={actions.playNext}
          onAddToQueue={actions.addToQueue}
          onRemove={(item) => item.video_id && onUnlike(item.video_id)}
          removeLabel="unlike"
          currentVideoId={currentVideoId}
          loadingVideoId={loadingVideoId}
          isPlaying={isPlaying}
        />
      )}
    </div>
  );
}
