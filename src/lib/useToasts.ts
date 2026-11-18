import { useCallback, useEffect, useRef, useState } from "react";
import type { Toast } from "../types";

const MAX_TOASTS = 3;

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const clearTimer = (id: number) => {
    const t = timers.current.get(id);
    if (t != null) window.clearTimeout(t);
    timers.current.delete(id);
  };

  const dismiss = useCallback((id: number) => {
    clearTimer(id);
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (message: string, kind: Toast["kind"] = "info") => {
      const id = nextId.current++;
      setToasts((list) => {
        // Replace an identical visible toast instead of stacking duplicates.
        const rest = list.filter((x) => {
          if (x.message === message && x.kind === kind) {
            clearTimer(x.id);
            return false;
          }
          return true;
        });
        const all = [...rest, { id, message, kind }];
        all.slice(0, Math.max(0, all.length - MAX_TOASTS)).forEach((d) => clearTimer(d.id));
        return all.slice(-MAX_TOASTS);
      });
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), kind === "error" ? 6000 : 4000)
      );
    },
    [dismiss]
  );

  useEffect(() => {
    const map = timers.current;
    return () => map.forEach((t) => window.clearTimeout(t));
  }, []);

  return { toasts, push, dismiss };
}
