import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { importSpotify, importTracks } from "../api";
import type { ImportResult } from "../types";
import { isSpotifyLink, parseTrackFile } from "../lib/importFile";
import { friendlyError } from "../lib/format";
import { Spinner } from "./Spinner";

interface Props {
  /** Start importing this link right away (pasted into search). */
  initialLink?: string;
  /** Save the matched songs as a playlist; returns its id. */
  onSave: (name: string, result: ImportResult) => void;
  onClose: () => void;
}

type Phase =
  | { kind: "idle"; error?: string }
  | { kind: "working"; what: string; done: number; total: number }
  | { kind: "done"; result: ImportResult };

const bar = (done: number, total: number, cells = 24) => {
  const f = total > 0 ? Math.round((done / total) * cells) : 0;
  return "█".repeat(f) + "░".repeat(cells - f);
};

/** Modal: import a Spotify playlist / album link or a CSV export. */
export function ImportDialog({ initialLink, onSave, onClose }: Props) {
  const [link, setLink] = useState(initialLink ?? "");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [showMissing, setShowMissing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const started = useRef(false);
  const working = phase.kind === "working";

  useEffect(() => {
    let un: (() => void) | undefined;
    let dead = false;
    listen<{ done: number; total: number }>("import-progress", (e) => {
      setPhase((p) => (p.kind === "working" ? { ...p, done: e.payload.done, total: e.payload.total } : p));
    })
      .then((u) => (dead ? u() : (un = u)))
      .catch(() => {});
    return () => {
      dead = true;
      un?.();
    };
  }, []);

  const run = async (what: string, job: () => Promise<ImportResult>) => {
    setPhase({ kind: "working", what, done: 0, total: 0 });
    try {
      const result = await job();
      setPhase({ kind: "done", result });
    } catch (e) {
      setPhase({ kind: "idle", error: friendlyError(e) });
    }
  };

  const startLink = (url: string) => {
    if (!isSpotifyLink(url)) {
      setPhase({ kind: "idle", error: "Paste a Spotify playlist, album or song link" });
      return;
    }
    run("reading spotify…", () => importSpotify(url.trim()));
  };

  useEffect(() => {
    if (initialLink && !started.current) {
      started.current = true;
      startLink(initialLink);
    } else {
      inputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const text = await f.text();
    const tracks = parseTrackFile(text);
    if (!tracks.length) {
      setPhase({ kind: "idle", error: "No songs found in that file (needs title / artist columns)" });
      return;
    }
    const name = f.name.replace(/\.(csv|txt|tsv)$/i, "").replace(/[_-]+/g, " ").trim() || "imported";
    run(`matching ${tracks.length} songs…`, () => importTracks(name, tracks));
  };

  const close = () => {
    if (!working) onClose();
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal panel import"
        role="dialog"
        aria-label="Import playlist"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <span className="panel-title">import playlist</span>

        {phase.kind === "done" ? (
          <>
            <div className="import-name">{phase.result.name}</div>
            <div>
              found <span className="accent">{phase.result.items.length}</span> of{" "}
              {phase.result.items.length + phase.result.missing.length} songs on youtube music
            </div>
            {phase.result.truncated ? (
              <div className="set-hint">
                spotify only shows the first 100 songs of a link. for the rest, export the playlist as CSV
                (e.g. exportify.net) and import the file.
              </div>
            ) : null}
            {phase.result.missing.length ? (
              <>
                <button className="row-btn import-toggle" onClick={() => setShowMissing((v) => !v)}>
                  {showMissing ? "▾" : "▸"} {phase.result.missing.length} not found
                </button>
                {showMissing ? (
                  <div className="pick-list import-missing">
                    {phase.result.missing.map((m, i) => (
                      <div key={i} className="dim ellipsis">
                        {m}
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : null}
            <div className="import-actions">
              <button
                className="kbtn play-btn"
                disabled={!phase.result.items.length}
                onClick={() => onSave(phase.result.name, phase.result)}
                autoFocus
              >
                save as playlist
              </button>
              <button className="kbtn" onClick={onClose}>
                cancel
              </button>
            </div>
          </>
        ) : working ? (
          <div className="import-progress">
            <div>
              <Spinner /> {phase.total ? "matching songs on youtube music…" : phase.what}
            </div>
            <div className="import-bar">
              <span className="accent">{bar(phase.done, phase.total)}</span>{" "}
              <span className="dim">
                {phase.done}/{phase.total || "?"}
              </span>
            </div>
          </div>
        ) : (
          <>
            <div className="modal-sub">paste a spotify playlist, album or song link</div>
            <form
              className="pick-new"
              onSubmit={(e) => {
                e.preventDefault();
                startLink(link);
              }}
            >
              <span className="search-prompt">⇣</span>
              <input
                ref={inputRef}
                value={link}
                onChange={(e) => {
                  setLink(e.target.value);
                  if (isSpotifyLink(e.target.value)) startLink(e.target.value);
                }}
                placeholder="https://open.spotify.com/playlist/…"
                spellCheck={false}
              />
            </form>
            <div className="import-or dim">
              or{" "}
              <button className="kbtn" onClick={() => fileRef.current?.click()}>
                choose a CSV file
              </button>{" "}
              <span className="set-hint">for long playlists (exportify.net, tunemymusic…)</span>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              hidden
              onChange={(e) => {
                onFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            {phase.error ? <div className="import-error">{phase.error}</div> : null}
            <div className="modal-hint dim">
              songs are matched by title, artist and length · <kbd>esc</kbd> close
            </div>
          </>
        )}
      </div>
    </div>
  );
}
