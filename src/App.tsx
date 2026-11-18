import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { backendStatus, browseHome } from "./api";
import { Sidebar } from "./components/Sidebar";
import { PlayerBar } from "./components/PlayerBar";
import { HomeView } from "./components/HomeView";
import { ClearSearchButton, SearchView } from "./components/SearchView";
import { TrackList } from "./components/TrackList";
import { Toasts } from "./components/Toasts";
import { StatusLine } from "./components/StatusLine";
import { ArtistView } from "./components/ArtistView";
import { CollectionView } from "./components/CollectionView";
import { LyricsView } from "./components/LyricsView";
import { PlaylistView } from "./components/PlaylistView";
import { PlaylistPicker } from "./components/PlaylistPicker";
import { usePlaylists } from "./lib/usePlaylists";
import { usePlayer } from "./lib/usePlayer";
import type { PlayerCallbacks } from "./lib/usePlayer";
import { useQueue } from "./lib/useQueue";
import { useSearch } from "./lib/useSearch";
import { useToasts } from "./lib/useToasts";
import { useShortcuts } from "./lib/useShortcuts";
import { useMediaSession } from "./lib/useMediaSession";
import { useRecent } from "./lib/useRecent";
import { useDiscordPresence } from "./lib/useDiscordPresence";
import { ActionsContext } from "./lib/actions";
import type { Actions } from "./lib/actions";
import { artistLabel } from "./lib/format";
import type { BackendStatus, Item, Route, Shelf, View } from "./types";

const TOP_LEVEL = new Set(["home", "search", "queue"]);

export default function App() {
  // Page stack: top-level views reset it, pages (artist/album/lyrics) push onto it.
  const [stack, setStack] = useState<Route[]>([{ name: "home" }]);
  const route = stack[stack.length - 1];
  const topView = (TOP_LEVEL.has(route.name) ? route.name : null) as View | null;
  const searchInput = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const [status, setStatus] = useState<BackendStatus | null>(null);
  const [settingUp, setSettingUp] = useState(false);

  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [homeLoading, setHomeLoading] = useState(true);
  const [homeError, setHomeError] = useState(false);

  const { toasts, push, dismiss } = useToasts();
  const { recent, record, forget, hiddenArtists, hideArtist, unhideAll } = useRecent();
  const pl = usePlaylists();
  /** Songs waiting for the "add to playlist" picker (null = closed). */
  const [picking, setPicking] = useState<Item[] | null>(null);

  // Player <-> queue wiring: the player's callbacks are provided by the queue.
  const handlersRef = useRef<PlayerCallbacks>({});
  const player = usePlayer({
    onEnded: () => handlersRef.current.onEnded?.(),
    onError: (m, it) => handlersRef.current.onError?.(m, it),
    onStarted: (it) => handlersRef.current.onStarted?.(it),
  });
  const queue = useQueue(player, push);
  handlersRef.current = queue.handlers;

  // ---- navigation ------------------------------------------------------------

  const go = useCallback((r: Route) => {
    setStack((s) => {
      const cur = s[s.length - 1];
      if (TOP_LEVEL.has(r.name)) return [r];
      if (JSON.stringify(cur) === JSON.stringify(r)) return s;
      return [...s, r].slice(-30);
    });
    contentRef.current?.scrollTo({ top: 0 });
  }, []);

  const back = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  const toggleLyrics = useCallback(() => {
    setStack((s) => (s[s.length - 1].name === "lyrics" ? (s.length > 1 ? s.slice(0, -1) : [{ name: "home" }]) : [...s, { name: "lyrics" }]));
  }, []);

  const search = useSearch(
    useCallback((m: string) => push(m, "error"), [push]),
    useCallback(() => go({ name: "search" }), [go])
  );

  // ---- initial load --------------------------------------------------------

  const loadHome = useCallback(() => {
    setHomeLoading(true);
    setHomeError(false);
    browseHome()
      .then(setShelves)
      .catch(() => setHomeError(true))
      .finally(() => setHomeLoading(false));
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen("backend-setup", () => setSettingUp(true))
      .then((u) => (cancelled ? u() : (unlisten = u)))
      .catch(() => {});

    backendStatus()
      .then(setStatus)
      .catch(() => setStatus({ ytdlp_available: false, path: null, version: null }))
      .finally(() => setSettingUp(false));
    loadHome();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [loadHome]);

  // Mouse "back" button.
  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        back();
      }
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [back]);

  // ---- recently played -------------------------------------------------------
  // A song only counts once it has really been listened to: 30 s, or half of a
  // short track. Accidental clicks never reach "recently played" / "your artists".
  const recordedId = useRef<string | null>(null);
  useEffect(() => {
    const t = player.track;
    if (!t?.video_id || recordedId.current === t.video_id || !player.isPlaying) return;
    const dur = (player.duration || t.duration_ms || 0) / 1000;
    const need = dur > 0 ? Math.min(30, dur / 2) : 30;
    if (player.currentTime >= need) {
      recordedId.current = t.video_id;
      record(t);
    }
  }, [player.track, player.currentTime, player.isPlaying, player.duration, record]);
  useEffect(() => {
    // A new track (or the same one played again later) can count again.
    if (player.track?.video_id !== recordedId.current) recordedId.current = null;
  }, [player.track]);

  // ---- window title --------------------------------------------------------

  const { track, isPlaying } = player;
  useEffect(() => {
    const title =
      track && isPlaying ? `${track.title} · ${artistLabel(track)} — Melodi` : "Melodi";
    document.title = title;
    try {
      getCurrentWindow()
        .setTitle(title)
        .catch(() => {});
    } catch {
      /* not running inside Tauri */
    }
  }, [track, isPlaying]);

  // ---- shortcuts & media keys ----------------------------------------------

  const focusSearch = useCallback(() => {
    go({ name: "search" });
    // The input lives in the top bar and is always mounted.
    requestAnimationFrame(() => {
      searchInput.current?.focus();
      searchInput.current?.select();
    });
  }, [go]);

  const navigate = (v: View) => {
    if (v === "search") focusSearch();
    else go({ name: v } as Route);
  };

  /** j/k: move keyboard focus through the rows/cards of the current view. */
  const moveFocus = useCallback((dir: 1 | -1) => {
    const main = document.querySelector(".main");
    if (!main) return;
    const els = [...main.querySelectorAll<HTMLElement>(".nav-target")];
    if (els.length === 0) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const next = i < 0 ? (dir > 0 ? 0 : els.length - 1) : Math.min(els.length - 1, Math.max(0, i + dir));
    els[next].focus();
    els[next].scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);

  useShortcuts({
    toggle: player.toggle,
    seekBy: (s) => {
      const max = (player.duration || 0) / 1000;
      const t = player.getCurrentTime() + s;
      player.seek(max > 0 ? Math.min(max, t) : t);
    },
    next: queue.next,
    prev: queue.prev,
    volumeBy: (d) => player.setVolume(player.volume + d),
    toggleMute: player.toggleMute,
    focusSearch,
    showView: (v) => navigate(v),
    moveFocus,
    back,
    lyrics: toggleLyrics,
  });
  useMediaSession(player, { next: queue.next, prev: queue.prev });
  const discord = useDiscordPresence(player);

  // ---- actions ---------------------------------------------------------------

  const actions: Actions = useMemo(
    () => ({
      open: (item: Item) => {
        if (!item.browse_id) return;
        if (item.kind === "artist") go({ name: "artist", id: item.browse_id, title: item.title });
        else go({ name: "collection", id: item.browse_id, title: item.title });
      },
      openArtist: (id, name) => go({ name: "artist", id, title: name }),
      openAlbum: (id, title) => go({ name: "collection", id, title }),
      startRadio: queue.startRadio,
      playNext: queue.playNext,
      addToQueue: queue.addToQueue,
      addToPlaylist: (items: Item[]) => {
        const songs = items.filter((i) => i.video_id);
        if (songs.length) setPicking(songs);
      },
    }),
    // queue functions are recreated each render but read state through refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [go, queue.queue]
  );

  const playFromSearch = (songs: Item[], index: number) => {
    search.remember(search.query);
    queue.playList(songs, index);
  };

  const currentVideoId = player.track?.video_id ?? null;
  const loadingVideoId = player.isLoading ? currentVideoId : null;
  const rowProps = { currentVideoId, loadingVideoId, isPlaying };

  // Queue view sections.
  const cur = queue.currentIndex;
  const nowItem = cur != null ? queue.queue[cur] : null;
  const upNextOffset = cur != null ? cur + 1 : 0;
  const upNext = queue.queue.slice(upNextOffset);
  const earlier = cur != null ? queue.queue.slice(0, cur) : [];
  const autoStart = upNext.findIndex((i) => i.video_id && queue.autoIds.has(i.video_id));

  const openPlaylist = route.name === "playlist" ? pl.playlists.find((p) => p.id === route.id) : undefined;
  const panelTitle =
    route.name === "artist" || route.name === "collection"
      ? `${route.name === "artist" ? "artist · " : ""}${route.title.toLowerCase()}`
      : route.name === "playlist"
        ? `playlist · ${(openPlaylist?.name ?? "").toLowerCase()}`
        : route.name;

  const pickPlaylist = (id: string) => {
    if (!picking) return;
    const name = pl.playlists.find((p) => p.id === id)?.name ?? "playlist";
    const n = pl.add(id, picking);
    push(n ? `Added ${n === 1 ? "1 song" : `${n} songs`} to ${name}` : `Already in ${name}`);
    setPicking(null);
  };
  const createFromPicker = (name: string) => {
    if (!picking) return;
    pl.create(name, picking);
    push(`Created ${name} · ${picking.length === 1 ? "1 song" : `${picking.length} songs`}`);
    setPicking(null);
  };

  return (
    <ActionsContext.Provider value={actions}>
      <div className="app">
        <Sidebar
          view={topView}
          onNavigate={navigate}
          queueCount={queue.queue.length}
          lyricsOpen={route.name === "lyrics"}
          onLyrics={toggleLyrics}
          playlists={pl.playlists}
          activePlaylistId={route.name === "playlist" ? route.id : null}
          onOpenPlaylist={(id) => go({ name: "playlist", id })}
          onCreatePlaylist={(name) => go({ name: "playlist", id: pl.create(name) })}
        />

        <main className="main panel">
          <span className="panel-title">{panelTitle}</span>
          <div className="topbar">
            {stack.length > 1 ? (
              <button className="kbtn back-btn" onClick={back} title="Back (Backspace)">
                ← back
              </button>
            ) : null}
            <div className="search-box">
              <span className="search-prompt">/</span>
              <input
                ref={searchInput}
                value={search.query}
                onChange={(e) => search.onQueryChange(e.target.value)}
                onFocus={() => route.name !== "search" && search.query && go({ name: "search" })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    search.onQueryChange("");
                    e.currentTarget.blur();
                  } else if (e.key === "Enter") {
                    search.remember(search.query);
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    e.currentTarget.blur();
                    moveFocus(1);
                  }
                }}
                placeholder="search songs, artists, albums"
                aria-label="Search"
                spellCheck={false}
              />
              {search.query ? (
                <ClearSearchButton
                  onClick={() => {
                    search.onQueryChange("");
                    searchInput.current?.focus();
                  }}
                />
              ) : null}
            </div>
          </div>

          <div className="content" ref={contentRef}>
            {route.name === "home" && (
              <HomeView
                shelves={shelves}
                loading={homeLoading}
                error={homeError}
                recent={recent}
                hiddenCount={hiddenArtists.length}
                onForget={forget}
                onHideArtist={(id) => {
                  hideArtist(id);
                  push("Artist hidden from your artists");
                }}
                onUnhideAll={unhideAll}
                onRetry={loadHome}
                onPlayList={queue.playList}
              />
            )}

            {route.name === "search" && (
              <SearchView
                query={search.query}
                searching={search.searching}
                hasSearched={search.hasSearched}
                results={search.results}
                history={search.history}
                onPickHistory={search.onQueryChange}
                onClearHistory={search.clearHistory}
                onPlayList={playFromSearch}
                onPlayNext={queue.playNext}
                onAddToQueue={queue.addToQueue}
                {...rowProps}
              />
            )}

            {route.name === "artist" && (
              <ArtistView
                key={route.id}
                id={route.id}
                name={route.title}
                onPlayList={queue.playList}
                onPlayRadio={queue.playRadio}
                {...rowProps}
              />
            )}

            {route.name === "collection" && (
              <CollectionView
                key={route.id}
                id={route.id}
                title={route.title}
                onPlayList={queue.playList}
                {...rowProps}
              />
            )}

            {route.name === "playlist" && (
              <PlaylistView
                key={route.id}
                playlist={openPlaylist}
                onPlayList={queue.playList}
                onRename={(name) => pl.rename(route.id, name)}
                onDelete={() => {
                  pl.remove(route.id);
                  push(`Deleted ${openPlaylist?.name ?? "playlist"}`);
                  back();
                }}
                onRemoveAt={(i) => pl.removeAt(route.id, i)}
                onMove={(from, to) => pl.move(route.id, from, to)}
                {...rowProps}
              />
            )}

            {route.name === "lyrics" && (
              <LyricsView track={player.track} currentTime={player.currentTime} onSeek={player.seek} />
            )}

            {route.name === "queue" && (
              <div>
                <div className="view-header">
                  <h2 className="view-title">
                    queue <span className="count">{queue.queue.length}</span>
                  </h2>
                  <div className="view-actions">
                    <button
                      className={`kbtn checkbox ${queue.autoplay ? "on" : ""}`}
                      role="switch"
                      aria-checked={queue.autoplay}
                      onClick={() => queue.setAutoplay(!queue.autoplay)}
                      title="Keep playing similar songs when the queue runs out"
                    >
                      [{queue.autoplay ? "x" : " "}] autoplay
                    </button>
                    {queue.queue.length > 0 ? (
                      <button className="kbtn" onClick={() => setPicking(queue.queue)} title="Save the queue as a playlist">
                        + save
                      </button>
                    ) : null}
                    {queue.queue.length > 0 ? (
                      <button className="kbtn danger" onClick={queue.clear}>
                        clear
                      </button>
                    ) : null}
                  </div>
                </div>

                {queue.queue.length === 0 ? (
                  <div className="state">
                    <span className="state-art">[ queue empty ]</span>
                    <span>press / to search or 1 for home.</span>
                  </div>
                ) : (
                  <>
                    {nowItem ? (
                      <section className="queue-section">
                        <h3 className="section-label">now playing</h3>
                        <TrackList
                          items={[nowItem]}
                          header={false}
                          indexBase={cur ?? 0}
                          onPlay={() => player.toggle()}
                          {...rowProps}
                        />
                      </section>
                    ) : null}

                    <section className="queue-section">
                      <h3 className="section-label">up next</h3>
                      {upNext.length === 0 ? (
                        <div className="queue-empty">
                          -- nothing queued
                          {queue.autoplay ? " · similar songs will play automatically" : ""} --
                        </div>
                      ) : (
                        <TrackList
                          items={upNext}
                          indexBase={upNextOffset}
                          onPlay={(_, i) => queue.playAt(i + upNextOffset)}
                          onPlayNext={(item) => queue.playNext(item)}
                          onRemove={(_, i) => queue.removeAt(i + upNextOffset)}
                          onReorder={(from, to) => queue.move(from + upNextOffset, to + upNextOffset)}
                          dividerAt={autoStart >= 0 ? autoStart : undefined}
                          dividerLabel="autoplay · similar songs"
                          {...rowProps}
                        />
                      )}
                    </section>

                    {earlier.length > 0 ? (
                      <section className="queue-section">
                        <h3 className="section-label">history</h3>
                        <TrackList
                          items={earlier}
                          header={false}
                          dim
                          onPlay={(_, i) => queue.playAt(i)}
                          onRemove={(_, i) => queue.removeAt(i)}
                          {...rowProps}
                        />
                      </section>
                    ) : null}
                  </>
                )}
              </div>
            )}
          </div>
        </main>

        <PlayerBar
          player={player}
          shuffle={queue.shuffle}
          repeat={queue.repeat}
          canNext={queue.canNext}
          canPrev={queue.canPrev}
          onShuffle={() => queue.setShuffle(!queue.shuffle)}
          onRepeat={queue.cycleRepeat}
          onNext={queue.next}
          onPrev={queue.prev}
          onOpenQueue={() => go({ name: "queue" })}
          lyricsOpen={route.name === "lyrics"}
          onLyrics={toggleLyrics}
        />

        <StatusLine
          view={panelTitle}
          isPlaying={isPlaying}
          hasTrack={!!player.track}
          isLoading={player.isLoading}
          queueCount={queue.queue.length}
          volume={player.volume}
          status={status}
          settingUp={settingUp}
          discord={discord.available ? { on: discord.enabled, toggle: () => discord.setEnabled(!discord.enabled) } : null}
        />

        {picking ? (
          <PlaylistPicker
            items={picking}
            playlists={pl.playlists}
            onPick={pickPlaylist}
            onCreate={createFromPicker}
            onClose={() => setPicking(null)}
          />
        ) : null}

        <Toasts toasts={toasts} onDismiss={dismiss} />
      </div>
    </ActionsContext.Provider>
  );
}
