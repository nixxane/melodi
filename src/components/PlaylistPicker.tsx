import { useEffect, useRef, useState } from "react";
import type { Item } from "../types";
import type { Playlist } from "../lib/usePlaylists";

interface Props {
  items: Item[];
  playlists: Playlist[];
  onPick: (id: string) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}

/** Modal: choose a playlist to add `items` to, or create a new one. */
export function PlaylistPicker({ items, playlists, onPick, onCreate, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const what = items.length === 1 ? `“${items[0].title}”` : `${items.length} songs`;

  useEffect(() => {
    // Focus the first playlist, or the name field when there are none.
    const first = ref.current?.querySelector<HTMLButtonElement>(".pick-item");
    (first ?? inputRef.current)?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    const inInput = e.target === inputRef.current;
    const step =
      e.key === "ArrowDown" || (!inInput && e.key === "j") ? 1 : e.key === "ArrowUp" || (!inInput && e.key === "k") ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const els = [...(ref.current?.querySelectorAll<HTMLElement>(".pick-item, .pick-new input") ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    els[(i + step + els.length) % els.length]?.focus();
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        ref={ref}
        className="modal panel"
        role="dialog"
        aria-label="Add to playlist"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <span className="panel-title">add to playlist</span>
        <div className="modal-sub">{what}</div>

        <div className="pick-list">
          {playlists.length === 0 ? <div className="dim">-- no playlists yet --</div> : null}
          {playlists.map((p) => {
            const has = items.length === 1 && p.items.some((i) => i.video_id === items[0].video_id);
            return (
              <button key={p.id} className="pick-item" onClick={() => onPick(p.id)} disabled={has}>
                <span className="pick-name">{p.name}</span>
                <span className="dim">{has ? "added" : `${p.items.length}`}</span>
              </button>
            );
          })}
        </div>

        <form
          className="pick-new"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onCreate(name.trim());
          }}
        >
          <span className="search-prompt">+</span>
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="new playlist name, then enter"
            spellCheck={false}
            maxLength={80}
          />
        </form>
        <div className="modal-hint dim">
          <kbd>↑↓</kbd> move · <kbd>enter</kbd> add · <kbd>esc</kbd> close
        </div>
      </div>
    </div>
  );
}
