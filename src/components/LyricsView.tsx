import { useEffect, useMemo, useRef, useState } from "react";
import { fetchLyrics } from "../api";
import type { Item, Lyrics } from "../types";
import { artistLabel, friendlyError } from "../lib/format";
import { Spinner } from "./Spinner";

interface Props {
  track: Item | null;
  /** Playback position in seconds. */
  currentTime: number;
  onSeek: (seconds: number) => void;
}

const cache = new Map<string, Lyrics>();

export function LyricsView({ track, currentTime, onSeek }: Props) {
  const id = track?.video_id ?? null;
  const [lyrics, setLyrics] = useState<Lyrics | null>(id ? cache.get(id) ?? null : null);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const activeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!track || !id) return;
    setError(null);
    setFollow(true);
    const hit = cache.get(id);
    if (hit) {
      setLyrics(hit);
      return;
    }
    setLyrics(null);
    let live = true;
    fetchLyrics(track, track.artists[0] ?? artistLabel(track))
      .then((l) => {
        cache.set(id, l);
        if (live) setLyrics(l);
      })
      .catch((e) => live && setError(friendlyError(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const lines = lyrics?.synced ?? null;
  const ms = currentTime * 1000 + 250; // show a line slightly early
  const active = useMemo(() => {
    if (!lines) return -1;
    let lo = 0;
    let hi = lines.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].t <= ms) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }, [lines, ms]);

  useEffect(() => {
    if (follow) activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [active, follow]);

  if (!track) {
    return (
      <div className="state">
        <span className="state-art">[ lyrics ]</span>
        <span>play something first.</span>
      </div>
    );
  }

  const head = (
    <div className="lyrics-head">
      <div>
        <span className="now-title">{track.title}</span>
        <span className="dim"> — {artistLabel(track)}</span>
      </div>
      {lines ? (
        <button className={`kbtn checkbox ${follow ? "on" : ""}`} onClick={() => setFollow((f) => !f)}>
          [{follow ? "x" : " "}] follow
        </button>
      ) : null}
    </div>
  );

  if (error) {
    return (
      <div>
        {head}
        <div className="state">
          <span className="state-art err">[ ERR ] {error}</span>
        </div>
      </div>
    );
  }
  if (!lyrics) {
    return (
      <div>
        {head}
        <div className="term-line">
          <Spinner /> looking up lyrics…
        </div>
      </div>
    );
  }
  if (!lines && !lyrics.plain) {
    return (
      <div>
        {head}
        <div className="state">
          <span className="state-art">[ no lyrics ]</span>
          <span>couldn't find lyrics for this track.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="lyrics" onWheel={() => setFollow(false)}>
      {head}
      {lines ? (
        <div className="lyrics-lines synced">
          {lines.map((l, i) => (
            <button
              key={`${l.t}-${i}`}
              ref={i === active ? activeRef : undefined}
              className={`lyric ${i === active ? "active" : i < active ? "past" : ""}`}
              onClick={() => {
                onSeek(l.t / 1000);
                setFollow(true);
              }}
              title="Jump here"
            >
              {l.text || "♪"}
            </button>
          ))}
        </div>
      ) : (
        <pre className="lyrics-lines plain">{lyrics.plain}</pre>
      )}
      <div className="lyrics-source">source: {lyrics.source}</div>
    </div>
  );
}
