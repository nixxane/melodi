import { useState } from "react";
import type { View } from "../types";
import type { Playlist } from "../lib/usePlaylists";

interface Props {
  view: View | null;
  onNavigate: (v: View) => void;
  queueCount: number;
  lyricsOpen: boolean;
  onLyrics: () => void;
  playlists: Playlist[];
  activePlaylistId: string | null;
  onOpenPlaylist: (id: string) => void;
  onCreatePlaylist: (name: string) => void;
}

const ITEMS: { id: View; key: string; label: string }[] = [
  { id: "home", key: "1", label: "home" },
  { id: "search", key: "2", label: "search" },
  { id: "queue", key: "3", label: "queue" },
];

export function Sidebar({
  view,
  onNavigate,
  queueCount,
  lyricsOpen,
  onLyrics,
  playlists,
  activePlaylistId,
  onOpenPlaylist,
  onCreatePlaylist,
}: Props) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const finish = (save: boolean) => {
    if (save && name.trim()) onCreatePlaylist(name.trim());
    setName("");
    setCreating(false);
  };

  return (
    <aside className="sidebar panel">
      <span className="panel-title">melodi</span>

      <nav className="nav" aria-label="Main">
        {ITEMS.map((it) => {
          const active = view === it.id;
          return (
            <button
              key={it.id}
              className={`nav-item ${active ? "active" : ""}`}
              aria-current={active ? "page" : undefined}
              onClick={() => onNavigate(it.id)}
              title={`${it.label} (${it.key})`}
            >
              <span className="nav-cursor">{active ? ">" : " "}</span>
              <span className="nav-key">{it.key}</span>
              <span className="nav-label">{it.label}</span>
              {it.id === "queue" && queueCount > 0 ? (
                <span className="nav-badge">[{queueCount}]</span>
              ) : null}
            </button>
          );
        })}
        <button
          className={`nav-item ${lyricsOpen ? "active" : ""}`}
          aria-current={lyricsOpen ? "page" : undefined}
          onClick={onLyrics}
          title="lyrics (l)"
        >
          <span className="nav-cursor">{lyricsOpen ? ">" : " "}</span>
          <span className="nav-key">l</span>
          <span className="nav-label">lyrics</span>
        </button>
      </nav>

      <div className="side-section">
        <div className="side-head">
          <span>playlists</span>
          <button className="row-btn" onClick={() => setCreating(true)} title="New playlist">
            + new
          </button>
        </div>

        <div className="side-list">
          {playlists.map((p) => {
            const active = p.id === activePlaylistId;
            return (
              <button
                key={p.id}
                className={`nav-item ${active ? "active" : ""}`}
                onClick={() => onOpenPlaylist(p.id)}
                title={`${p.name} · ${p.items.length} songs`}
              >
                <span className="nav-cursor">{active ? ">" : " "}</span>
                <span className="nav-label ellipsis">{p.name}</span>
                <span className="nav-badge">{p.items.length}</span>
              </button>
            );
          })}

          {creating ? (
            <form
              className="side-new"
              onSubmit={(e) => {
                e.preventDefault();
                finish(true);
              }}
            >
              <span className="search-prompt">+</span>
              <input
                autoFocus
                value={name}
                maxLength={80}
                spellCheck={false}
                placeholder="name…"
                onChange={(e) => setName(e.target.value)}
                onBlur={() => finish(true)}
                onKeyDown={(e) => e.key === "Escape" && finish(false)}
              />
            </form>
          ) : playlists.length === 0 ? (
            <div className="side-empty">-- none yet --</div>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
