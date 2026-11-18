import { useEffect, useState } from "react";
import { browseCollection } from "../api";
import type { Collection, Item } from "../types";
import { friendlyError } from "../lib/format";
import { useActions } from "../lib/actions";
import { PageArt } from "./ArtistView";
import { Card } from "./Card";
import { ShelfRow } from "./ShelfRow";
import { Spinner } from "./Spinner";
import { TrackList } from "./TrackList";

interface Props {
  id: string;
  title: string;
  onPlayList: (items: Item[], index: number) => void;
  currentVideoId: string | null;
  loadingVideoId: string | null;
  isPlaying: boolean;
}

/** Album or playlist page. */
export function CollectionView({
  id,
  title,
  onPlayList,
  currentVideoId,
  loadingVideoId,
  isPlaying,
}: Props) {
  const actions = useActions();
  const [data, setData] = useState<Collection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    browseCollection(id)
      .then((c) => live && setData(c))
      .catch((e) => live && setError(friendlyError(e)));
    return () => {
      live = false;
    };
  }, [id, attempt]);

  if (error) {
    return (
      <div className="state">
        <span className="state-art err">[ ERR ] {error}</span>
        <button className="kbtn" onClick={() => setAttempt((n) => n + 1)}>
          retry
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="term-line">
        <Spinner /> loading {title}…
      </div>
    );
  }

  const isAlbum = data.kind === "album";
  const shuffled = () => {
    const list = [...data.tracks].sort(() => Math.random() - 0.5);
    onPlayList(list, 0);
  };

  return (
    <div className="fade-in">
      <header className="page-header">
        <PageArt item={data} />
        <div className="page-meta">
          <span className="badge">{data.kind}</span>
          <h1 className="page-title">{data.title || title}</h1>
          <div className="page-sub">
            {data.artist && data.artist_id ? (
              <button className="link" onClick={() => actions.openArtist(data.artist_id!, data.artist!)}>
                {data.artist}
              </button>
            ) : data.artist ? (
              <span>{data.artist}</span>
            ) : null}
            {data.subtitle ? (
              <span className="dim">
                {data.artist ? " · " : ""}
                {data.subtitle}
              </span>
            ) : null}
          </div>
          {data.stats ? <div className="page-sub dim">{data.stats}</div> : null}
          <div className="page-actions">
            <button
              className="kbtn play-btn"
              disabled={!data.tracks.length}
              onClick={() => onPlayList(data.tracks, 0)}
            >
              ▶ play
            </button>
            <button className="kbtn" disabled={data.tracks.length < 2} onClick={shuffled}>
              shuffle
            </button>
            <button
              className="kbtn"
              disabled={!data.tracks.length}
              onClick={() => actions.addToPlaylist(data.tracks)}
              title="Save these songs to one of your playlists"
            >
              + save
            </button>
            {data.tracks[0] ? (
              <button className="kbtn" onClick={() => actions.startRadio(data.tracks[0])}>
                ≈ radio
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {data.description ? <p className="bio">{data.description}</p> : null}

      {data.tracks.length === 0 ? (
        <div className="state">
          <span className="state-art">[ empty ]</span>
          <span>nothing playable here.</span>
        </div>
      ) : (
        <TrackList
          items={data.tracks}
          thumbs={!isAlbum}
          onPlay={(_, i) => onPlayList(data.tracks, i)}
          onPlayNext={actions.playNext}
          onAddToQueue={actions.addToQueue}
          currentVideoId={currentVideoId}
          loadingVideoId={loadingVideoId}
          isPlaying={isPlaying}
        />
      )}

      {data.shelves.map((shelf, si) => (
        <section className="shelf" key={`${shelf.title}-${si}`} style={{ marginTop: 22 }}>
          <h2 className="shelf-title">
            <span>{shelf.title.toLowerCase()}</span>
            <span className="shelf-count">{shelf.items.length}</span>
          </h2>
          <ShelfRow>
            {shelf.items.map((item, ii) => (
              <Card
                key={`${item.video_id ?? item.browse_id ?? item.title}-${ii}`}
                item={item}
                onPlay={(it) => onPlayList([it], 0)}
              />
            ))}
          </ShelfRow>
        </section>
      ))}
    </div>
  );
}
