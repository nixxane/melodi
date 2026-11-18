import type { Item } from "../types";
import { artistLabel } from "../lib/format";
import { Art } from "./Art";
import { useActions } from "../lib/actions";
import { ContextMenu, useContextMenu } from "./ContextMenu";
import type { MenuItem } from "./ContextMenu";

interface Props {
  item: Item;
  onPlay: (item: Item) => void;
  /** Extra context-menu entries (e.g. "remove from recently played"). */
  extraMenu?: MenuItem[];
  /** Load the artwork immediately (cards visible when the page opens). */
  eager?: boolean;
}

export function songMenu(item: Item, play: () => void, actions: ReturnType<typeof useActions>): MenuItem[] {
  const m: MenuItem[] = [
    { label: "play", hint: "⏎", onClick: play },
    { label: "play next", onClick: () => actions.playNext(item) },
    { label: "add to queue", onClick: () => actions.addToQueue(item) },
    {
      label: actions.isLiked(item.video_id) ? "unlike" : "like",
      hint: "♥︎",
      onClick: () => actions.toggleLike(item),
    },
    { label: "add to playlist…", hint: "+", onClick: () => actions.addToPlaylist([item]) },
    { label: "start radio", hint: "≈", onClick: () => actions.startRadio(item) },
  ];
  if (item.artist_id) {
    m.push({ label: "go to artist", onClick: () => actions.openArtist(item.artist_id!, item.artists[0] ?? "") });
  }
  if (item.album_id) {
    m.push({ label: "go to album", onClick: () => actions.openAlbum(item.album_id!, item.title) });
  }
  return m;
}

export function Card({ item, onPlay, extraMenu, eager }: Props) {
  const ctx = useContextMenu();
  const actions = useActions();
  const isSong = item.kind === "song" && !!item.video_id;
  const isArtist = item.kind === "artist";
  const label = isSong ? artistLabel(item) : item.subtitle || item.kind;

  const activate = () => (isSong ? onPlay(item) : actions.open(item));
  const menu: MenuItem[] = isSong
    ? songMenu(item, () => onPlay(item), actions)
    : [{ label: `open ${item.kind}`, hint: "⏎", onClick: () => actions.open(item) }];
  if (extraMenu) menu.push(...extraMenu);

  return (
    <div
      className={`card nav-target ${isArtist ? "artist" : ""}`}
      tabIndex={0}
      role="button"
      aria-label={`${isSong ? "Play" : "Open"} ${item.title}`}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          activate();
        }
      }}
      onContextMenu={(e) => ctx.open(e, menu)}
    >
      <div className="card-art">
        <Art thumbnails={item.thumbnails} size={400} eager={eager} />
        <div className="card-play">{isSong ? "▶ play" : "→ open"}</div>
      </div>
      <div className="card-title" title={item.title}>
        {item.title}
      </div>
      <div className="card-sub">
        {!isSong ? <span className="badge">{item.kind}</span> : null}
        <span>{label}</span>
      </div>
      <ContextMenu menu={ctx.menu} onClose={ctx.close} />
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="card skeleton-card" aria-hidden="true">
      <div className="card-art skeleton" />
      <div className="skeleton skeleton-line" style={{ width: "80%", marginTop: 10 }} />
      <div className="skeleton skeleton-line" style={{ width: "55%", marginTop: 6 }} />
    </div>
  );
}
