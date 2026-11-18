import { useMemo, useState } from "react";
import type { Thumbnail } from "../types";
import { thumbCandidates } from "../lib/format";

interface Props {
  thumbnails: Thumbnail[] | undefined;
  /** Pixel size to request (about 2x the CSS size). */
  size: number;
  className?: string;
  /** Load right away instead of when scrolled near (for visible-on-arrival art). */
  eager?: boolean;
}

/**
 * Artwork with a ♪ placeholder, a fade-in once loaded, and fallback to the
 * other sizes YouTube provides if one URL fails, so covers never end up blank.
 */
export function Art({ thumbnails, size, className = "", eager }: Props) {
  const candidates = useMemo(() => thumbCandidates(thumbnails, size), [thumbnails, size]);
  const key = candidates[0] ?? "";

  // State is tied to the artwork it belongs to, so a new track/cover starts
  // fresh without an effect (an effect could run *after* a fast load error
  // and wipe out the fallback).
  const [st, setSt] = useState({ key, attempt: 0, loaded: false });
  const cur = st.key === key ? st : { key, attempt: 0, loaded: false };

  const src = candidates[cur.attempt];
  return (
    <span className={`art ${cur.loaded ? "loaded" : ""} ${className}`}>
      <span className="art-ph" aria-hidden="true">
        ♪
      </span>
      {src ? (
        <img
          key={src}
          src={src}
          alt=""
          draggable={false}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          onLoad={() => setSt({ key, attempt: cur.attempt, loaded: true })}
          onError={() =>
            setSt((s) => ({ key, attempt: (s.key === key ? s.attempt : 0) + 1, loaded: false }))
          }
        />
      ) : null}
    </span>
  );
}
