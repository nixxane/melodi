import { useEffect, useState } from "react";
import type { Item } from "../types";
import type { Playlist } from "../lib/usePlaylists";
import { formatTime } from "../lib/format";
import { useActions } from "../lib/actions";
import { PageArt } from "./ArtistView";
import { TrackList } from "./TrackList";

interface Props {
  playlist: Playlist | undefined;
  onPlayList: (items: Item[], index: number) => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onRemoveAt: (index: number) => void;
  onMove: (from: number, to: number) => void;
  currentVideoId: string | null;
  loadingVideoId: string | null;
  isPlaying: boolean;
}

/** A user's own (local) playlist. */
export function PlaylistView({
  playlist,
  onPlayList,
  onRename,
  onDelete,
  onRemoveAt,
  onMove,
  currentVideoId,
  loadingVideoId,
  isPlaying,
}: Props) {
  const actions = useActions();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(playlist?.name ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setName(playlist?.name ?? "");
    setRenaming(false);
    setConfirmDelete(false);
  }, [playlist?.id, playlist?.name]);

  // Arm "delete" for a few seconds; a second click deletes.
  useEffect(() => {
    if (!confirmDelete) return;
    const t = window.setTimeout(() => setConfirmDelete(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirmDelete]);

  if (!playlist) {
    return (
      <div className="state">
        <span className="state-art">[ not found ]</span>
        <span>this playlist was deleted.</span>
      </div>
    );
  }

  const items = playlist.items;
  const total = items.reduce((s, i) => s + (i.duration_ms ?? 0), 0);
  const cover = items.find((i) => i.thumbnails.length) ?? { thumbnails: [] };

  return (
    <div className="fade-in">
      <header className="page-header">
        <PageArt item={cover} />
        <div className="page-meta">
          <span className="badge">my playlist</span>
          {renaming ? (
            <form
              className="rename"
              onSubmit={(e) => {
                e.preventDefault();
                onRename(name);
                setRenaming(false);
              }}
            >
              <input
                autoFocus
                value={name}
                maxLength={80}
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => {
                  onRename(name);
                  setRenaming(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setName(playlist.name);
                    setRenaming(false);
                  }
                }}
              />
            </form>
          ) : (
            <h1 className="page-title" title="Click to rename" onDoubleClick={() => setRenaming(true)}>
              {playlist.name}
            </h1>
          )}
          <div className="page-sub dim">
            {items.length} {items.length === 1 ? "song" : "songs"}
            {total ? ` • ${formatTime(total)}` : ""}
          </div>
          <div className="page-actions">
            <button className="kbtn play-btn" disabled={!items.length} onClick={() => onPlayList(items, 0)}>
              ▶ play
            </button>
            <button
              className="kbtn"
              disabled={items.length < 2}
              onClick={() => onPlayList([...items].sort(() => Math.random() - 0.5), 0)}
            >
              shuffle
            </button>
            {items[0] ? (
              <button className="kbtn" onClick={() => actions.startRadio(items[Math.floor(Math.random() * items.length)])}>
                ≈ radio
              </button>
            ) : null}
            <button className="kbtn" onClick={() => setRenaming(true)}>
              rename
            </button>
            <button
              className={`kbtn danger ${confirmDelete ? "armed" : ""}`}
              onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
            >
              {confirmDelete ? "really delete?" : "delete"}
            </button>
          </div>
        </div>
      </header>

      {items.length === 0 ? (
        <div className="state">
          <span className="state-art">[ empty ]</span>
          <span>right-click any song → add to playlist, or use the + button on a row.</span>
        </div>
      ) : (
        <TrackList
          items={items}
          onPlay={(_, i) => onPlayList(items, i)}
          onPlayNext={actions.playNext}
          onAddToQueue={actions.addToQueue}
          onRemove={(_, i) => onRemoveAt(i)}
          removeLabel="remove from playlist"
          onReorder={onMove}
          currentVideoId={currentVideoId}
          loadingVideoId={loadingVideoId}
          isPlaying={isPlaying}
        />
      )}
    </div>
  );
}
