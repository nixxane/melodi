import type { Item, Shelf } from "../types";
import { greeting } from "../lib/format";
import { useActions } from "../lib/actions";
import { Card, CardSkeleton } from "./Card";
import { ShelfRow } from "./ShelfRow";
import { Spinner } from "./Spinner";

interface Props {
  shelves: Shelf[];
  loading: boolean;
  error: boolean;
  recent: Item[];
  hiddenCount: number;
  onForget: (videoId: string) => void;
  onHideArtist: (artistId: string) => void;
  onUnhideAll: () => void;
  onRetry: () => void;
  onPlayList: (items: Item[], index: number) => void;
}

function Header() {
  const now = new Date();
  const date = now
    .toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
    .toLowerCase();
  return (
    <div className="home-head">
      <span>
        good <span className="accent">{greeting(now)}</span>
      </span>
      <span className="dim">{date}</span>
    </div>
  );
}

/** Distinct artists from listening history, most recent first. */
function recentArtists(recent: Item[]) {
  const seen = new Map<string, string>();
  for (const it of recent) {
    if (it.artist_id && !seen.has(it.artist_id)) seen.set(it.artist_id, it.artists[0] ?? "");
  }
  return [...seen].slice(0, 12);
}

function ShelfSection({
  title,
  items,
  onPlayList,
  onForget,
}: {
  title: string;
  items: Item[];
  onPlayList: (items: Item[], index: number) => void;
  /** When set, cards get a "remove from recently played" menu entry. */
  onForget?: (videoId: string) => void;
}) {
  const songs = items.filter((i) => i.kind === "song" && i.video_id);
  return (
    <section className="shelf">
      {title ? (
        <h2 className="shelf-title">
          <span>{title.toLowerCase()}</span>
          <span className="shelf-count">{items.length}</span>
        </h2>
      ) : null}
      <ShelfRow>
        {items.map((item, ii) => (
          <Card
            key={item.video_id ?? `${item.kind}-${item.browse_id ?? item.title}-${ii}`}
            item={item}
            eager={ii < 8}
            onPlay={(it) =>
              onPlayList(
                songs,
                songs.findIndex((s) => s.video_id === it.video_id)
              )
            }
            extraMenu={
              onForget && item.video_id
                ? [{ label: "remove from recently played", danger: true, onClick: () => onForget(item.video_id!) }]
                : undefined
            }
          />
        ))}
      </ShelfRow>
    </section>
  );
}

export function HomeView({
  shelves,
  loading,
  error,
  recent,
  hiddenCount,
  onForget,
  onHideArtist,
  onUnhideAll,
  onRetry,
  onPlayList,
}: Props) {
  const actions = useActions();
  const artists = recentArtists(recent);

  return (
    <div>
      <Header />

      {recent.length > 0 ? (
        <ShelfSection title="recently played" items={recent} onPlayList={onPlayList} onForget={onForget} />
      ) : null}

      {artists.length > 0 || hiddenCount > 0 ? (
        <section className="shelf">
          <h2 className="shelf-title">
            <span>your artists</span>
            {hiddenCount > 0 ? (
              <button className="row-btn" onClick={onUnhideAll} title="Show hidden artists again">
                {hiddenCount} hidden · unhide
              </button>
            ) : null}
          </h2>
          <div className="artist-chips">
            {artists.map(([id, name]) => (
              <span key={id} className="chip-artist">
                <button className="chip-open nav-target" onClick={() => actions.openArtist(id, name)}>
                  {name}
                </button>
                <button
                  className="chip-x"
                  onClick={() => onHideArtist(id)}
                  title={`Hide ${name} from your artists`}
                  aria-label={`Hide ${name}`}
                >
                  x
                </button>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {loading ? (
        <div aria-busy="true" aria-label="Loading">
          <div className="term-line">
            <Spinner /> fetching shelves…
          </div>
          <div className="shelf-scroll">
            {Array.from({ length: 6 }, (_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        </div>
      ) : error ? (
        <div className="state">
          <span className="state-art err">[ ERR ] connection failed</span>
          <span>couldn't load your shelves — check your connection.</span>
          <button className="kbtn" onClick={onRetry}>
            retry
          </button>
        </div>
      ) : shelves.length === 0 ? (
        <div className="state">
          <span className="state-art">[ empty ]</span>
          <span>nothing here yet — press / to search.</span>
        </div>
      ) : (
        <div className="fade-in">
          {shelves.map((shelf, si) => (
            <ShelfSection
              key={`${shelf.title}-${si}`}
              title={shelf.title}
              items={shelf.items}
              onPlayList={onPlayList}
            />
          ))}
        </div>
      )}
    </div>
  );
}
