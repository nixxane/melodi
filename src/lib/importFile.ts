import type { SourceTrack } from "../types";

/** Is this a Spotify playlist / album / song link (or spotify: URI)? */
export function isSpotifyLink(input: string): boolean {
  const s = input.trim();
  return (
    /^(https?:\/\/)?open\.spotify\.com\/(intl-[a-z-]+\/)?(playlist|album|track)\/[A-Za-z0-9]{10,}/i.test(s) ||
    /^spotify:(playlist|album|track):[A-Za-z0-9]{10,}$/i.test(s)
  );
}

/** Split one CSV line, honouring quotes ("a, b" and "" escapes). */
function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/** Split CSV text into lines, keeping newlines that sit inside quotes. */
function csvLines(text: string): string[] {
  const lines: string[] = [];
  let cur = "";
  let quoted = false;
  for (const c of text.replace(/\r\n?/g, "\n")) {
    if (c === '"') quoted = !quoted;
    if (c === "\n" && !quoted) {
      lines.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur) lines.push(cur);
  return lines.filter((l) => l.trim());
}

const TITLE_COLS = ["track name", "title", "track", "song", "name", "song name"];
const ARTIST_COLS = ["artist name(s)", "artist name", "artists", "artist", "artist(s)"];
const DURATION_COLS = ["duration (ms)", "duration_ms", "duration"];

/**
 * Read a track list from a file: a CSV export (Exportify, TuneMyMusic, …)
 * with title / artist columns, or plain "Artist - Title" lines.
 */
export function parseTrackFile(text: string): SourceTrack[] {
  const lines = csvLines(text.replace(/^﻿/, ""));
  if (!lines.length) return [];
  const first = lines[0];
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : first.includes("\t") ? "\t" : ",";
  const header = splitCsvLine(first, sep).map((h) => h.toLowerCase());
  const col = (names: string[]) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
  const ti = col(TITLE_COLS);
  const ai = col(ARTIST_COLS);
  const di = col(DURATION_COLS);

  if (ti >= 0) {
    return lines.slice(1).flatMap((line) => {
      const cells = splitCsvLine(line, sep);
      const title = cells[ti];
      if (!title) return [];
      const artists = ai >= 0 ? (cells[ai] ?? "").split(/\s*[,;&]\s*|\s*\\,\s*/).filter(Boolean) : [];
      let duration_ms: number | null = null;
      if (di >= 0) {
        const raw = cells[di] ?? "";
        const mmss = raw.match(/^(\d+):(\d{2})$/);
        duration_ms = mmss ? (Number(mmss[1]) * 60 + Number(mmss[2])) * 1000 : Number(raw) || null;
      }
      return [{ title, artists, duration_ms }];
    });
  }

  // Plain text: "Artist - Title" per line.
  return lines.flatMap((line) => {
    const m = line.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m) return [{ title: m[2].trim(), artists: [m[1].trim()], duration_ms: null }];
    const t = line.trim();
    return t ? [{ title: t, artists: [], duration_ms: null }] : [];
  });
}
