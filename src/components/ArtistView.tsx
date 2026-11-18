import { useEffect, useState } from "react";
import { browseArtist } from "../api";
import type { Artist, Item } from "../types";
import { friendlyError, pickThumb } from "../lib/format";
import { useActions } from "../lib/actions";
import { Card } from "./Card";
import { ShelfRow } from "./ShelfRow";
import { Spinner } from "./Spinner";
import { TrackList } from "./TrackList";

interface Props {
  id: string;
  name: string;
  onPlayList: (items: Item[], index: number) => void;
  onPlayRadio: (videoId: string, playlistId: string, shuffle?: boolean) => void;
  currentVideoId: string | null;
  loadingVideoId: string | null;
  isPlaying: boolean;
}

export function ArtistView({
  id,
  name,
  onPlayList,
  onPlayRadio,
  currentVideoId,
  loadingVideoId,
  isPlaying,
}: Props) {
  const actions = useActions();
  const [artist, setArtist] = useState<Artist | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showBio, setShowBio] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setArtist(null);
    setError(null);
    setShowBio(false);
    browseArtist(id)
      .then((a) => live && setArtist(a))
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
  if (!artist) {
    return (
      <div className="term-line">
        <Spinner /> loading {name}…
      </div>
    );
  }

  const banner = artist.thumbnails.length
    ? artist.thumbnails.reduce((a, b) => (b.width > a.width ? b : a)).url
    : null;
  const bio = artist.description.trim();

  return (
    <div className="fade-in">
      <header className="page-header artist-header">
        {banner ? (
          <div className="artist-banner" style={{ backgroundImage: `url("${banner}")` }} aria-hidden="true" />
        ) : null}
        <div className="page-meta">
          <span className="badge">artist</span>
          <h1 className="page-title">{artist.name || name}</h1>
          {artist.audience ? <div className="page-sub">{artist.audience}</div> : null}
          <div className="page-actions">
            {artist.top_songs.length ? (
              <button className="kbtn play-btn" onClick={() => onPlayList(artist.top_songs, 0)}>
                ▶ play
              </button>
            ) : null}
            {artist.shuffle ? (
              <button
                className="kbtn"
                onClick={() => onPlayRadio(artist.shuffle!.video_id, artist.shuffle!.playlist_id, true)}
              >
                shuffle
              </button>
            ) : null}
            {artist.radio ? (
              <button
                className="kbtn"
                title="Songs by this artist and similar artists"
                onClick={() => onPlayRadio(artist.radio!.video_id, artist.radio!.playlist_id)}
              >
                ≈ artist radio
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {bio ? (
        <p className={`bio ${showBio ? "open" : ""}`}>
          {bio}{" "}
          <button className="row-btn" onClick={() => setShowBio((v) => !v)}>
            {showBio ? "less" : "more"}
          </button>
        </p>
      ) : null}

      {artist.top_songs.length ? (
        <section className="search-section">
          <div className="view-header">
            <h2 className="view-title">top songs</h2>
            {artist.top_songs_id ? (
              <button
                className="kbtn"
                onClick={() => actions.openAlbum(artist.top_songs_id!, `${artist.name} · top songs`)}
              >
                see all →
              </button>
            ) : null}
          </div>
          <TrackList
            items={artist.top_songs}
            onPlay={(_, i) => onPlayList(artist.top_songs, i)}
            onPlayNext={actions.playNext}
            onAddToQueue={actions.addToQueue}
            currentVideoId={currentVideoId}
            loadingVideoId={loadingVideoId}
            isPlaying={isPlaying}
          />
        </section>
      ) : null}

      {artist.shelves.map((shelf, si) => {
        const songs = shelf.items.filter((i) => i.kind === "song" && i.video_id);
        return (
          <section className="shelf" key={`${shelf.title}-${si}`}>
            <h2 className="shelf-title">
              <span>{shelf.title.toLowerCase()}</span>
              <span className="shelf-count">{shelf.items.length}</span>
            </h2>
            <ShelfRow>
              {shelf.items.map((item, ii) => (
                <Card
                  key={`${item.video_id ?? item.browse_id ?? item.title}-${ii}`}
                  item={item}
                  onPlay={(it) =>
                    onPlayList(
                      songs,
                      songs.findIndex((s) => s.video_id === it.video_id)
                    )
                  }
                />
              ))}
            </ShelfRow>
          </section>
        );
      })}
    </div>
  );
}

/** Square-ish artwork used by page headers. */
export function PageArt({ item, round }: { item: { thumbnails: Item["thumbnails"] }; round?: boolean }) {
  const url = pickThumb({ thumbnails: item.thumbnails } as Item, 400);
  return (
    <div className={`page-art ${round ? "round" : ""}`}>
      {url ? <img src={url} alt="" draggable={false} /> : <span>♪</span>}
    </div>
  );
}
