import { useCallback, useRef, useState } from "react";
import { search as searchApi, warmStream } from "../api";
import type { Item } from "../types";
import { friendlyError } from "./format";
import { loadJSON, saveJSON } from "./storage";

const HISTORY_KEY = "melodi.searches";
const MAX_HISTORY = 8;
/** Results must stay unchanged this long before the top song is looked up. */
const WARM_AFTER_MS = 700;

export function useSearch(onError: (msg: string) => void, onActive: () => void) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Item[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [history, setHistory] = useState<string[]>(() => {
    const h = loadJSON<unknown>(HISTORY_KEY, []);
    return Array.isArray(h) ? h.filter((x): x is string => typeof x === "string") : [];
  });
  const timer = useRef<number | null>(null);
  const requestId = useRef(0);
  const errRef = useRef(onError);
  errRef.current = onError;
  const activeRef = useRef(onActive);
  activeRef.current = onActive;

  const onQueryChange = useCallback((value: string) => {
    setQuery(value);
    activeRef.current();
    if (timer.current) window.clearTimeout(timer.current);
    const id = ++requestId.current; // invalidates any in-flight request

    const q = value.trim();
    if (!q) {
      setResults([]);
      setHasSearched(false);
      setSearching(false);
      return;
    }

    setSearching(true);
    setHasSearched(true);
    timer.current = window.setTimeout(async () => {
      try {
        const r = await searchApi(q);
        if (id !== requestId.current) return; // stale response
        setResults(r);
        // Start looking up the top song if the query has settled, so tapping
        // it plays sooner. Waits so typing doesn't look up every keystroke.
        const top = r.find((x) => x.video_id && (x.kind === "song" || x.kind === "video"));
        if (top === r[0] && top?.video_id) {
          const vid = top.video_id;
          window.setTimeout(() => {
            if (id === requestId.current) warmStream(vid);
          }, WARM_AFTER_MS);
        }
      } catch (e) {
        if (id !== requestId.current) return;
        setResults([]);
        errRef.current(friendlyError(e));
      } finally {
        if (id === requestId.current) setSearching(false);
      }
    }, 400);
  }, []);

  /** Remember a query (on Enter or when a result is played). */
  const remember = useCallback((value: string) => {
    const q = value.trim();
    if (!q) return;
    setHistory((h) => {
      const next = [q, ...h.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(
        0,
        MAX_HISTORY
      );
      saveJSON(HISTORY_KEY, next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    saveJSON(HISTORY_KEY, []);
  }, []);

  return {
    query,
    results,
    searching,
    hasSearched,
    history,
    onQueryChange,
    remember,
    clearHistory,
  };
}
