import { useEffect, useRef } from "react";

import type { View } from "../types";

export interface ShortcutHandlers {
  toggle: () => void;
  seekBy: (seconds: number) => void;
  next: () => void;
  prev: () => void;
  volumeBy: (delta: number) => void;
  toggleMute: () => void;
  focusSearch: () => void;
  showView: (v: View) => void;
  moveFocus: (dir: 1 | -1) => void;
  back: () => void;
  lyrics: () => void;
  like: () => void;
  settings: () => void;
  sleep: () => void;
}

/** Global keyboard shortcuts. Ignored while typing in text inputs. */
export function useShortcuts(handlers: ShortcutHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const h = ref.current;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const isRange = tag === "INPUT" && (t as HTMLInputElement).type === "range";
      const typing =
        !isRange &&
        (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!t?.isContentEditable);

      // Ctrl/Cmd+K works even from inside inputs.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        h.focusSearch();
        return;
      }
      // Alt+Left: back (browser convention).
      if (e.altKey && e.key === "ArrowLeft" && !typing) {
        e.preventDefault();
        h.back();
        return;
      }
      // Space always plays/pauses (except while typing). It must not also
      // "click" whatever button/row has focus, or scroll the page.
      if (e.key === " " && !typing) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) h.toggle();
        return;
      }

      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      // An open context menu handles its own keys (j/k, arrows, Esc).
      if (document.querySelector(".ctx-menu, .modal")) return;

      switch (e.key) {
        case "ArrowLeft":
          if (isRange) return; // let the focused slider handle it
          e.preventDefault();
          if (e.shiftKey) h.prev();
          else h.seekBy(-5);
          break;
        case "ArrowRight":
          if (isRange) return;
          e.preventDefault();
          if (e.shiftKey) h.next();
          else h.seekBy(5);
          break;
        case "ArrowUp":
          if (isRange) return;
          e.preventDefault();
          h.volumeBy(0.05);
          break;
        case "ArrowDown":
          if (isRange) return;
          e.preventDefault();
          h.volumeBy(-0.05);
          break;
        case "m":
        case "M":
          h.toggleMute();
          break;
        case "1":
          h.showView("home");
          break;
        case "2":
          e.preventDefault(); // don't type "2" into the search box we focus
          h.showView("search");
          break;
        case "3":
          h.showView("queue");
          break;
        case "j":
          e.preventDefault();
          h.moveFocus(1);
          break;
        case "k":
          e.preventDefault();
          h.moveFocus(-1);
          break;
        case "f":
        case "F":
          h.like();
          break;
        case "z":
        case "Z":
          h.sleep();
          break;
        case ",":
          h.settings();
          break;
        case "l":
        case "L":
          h.lyrics();
          break;
        case "Backspace":
          e.preventDefault();
          h.back();
          break;
        case "/":
          e.preventDefault();
          h.focusSearch();
          break;
      }
    };
    // Buttons fire their click on Space *keyup*; swallow that outside text fields.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== " ") return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const text =
        (tag === "INPUT" && (t as HTMLInputElement).type !== "range") ||
        tag === "TEXTAREA" ||
        !!t?.isContentEditable;
      if (!text) e.preventDefault();
    };
    // Capture phase: run before whatever element has focus.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, []);
}
