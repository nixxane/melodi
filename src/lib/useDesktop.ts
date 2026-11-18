import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import type { Item } from "../types";
import { artistLabel } from "./format";

const MINI = { width: 440, height: 116 };
const FULL_MIN = { width: 960, height: 620 };

interface Handlers {
  toggle: () => void;
  next: () => void;
  prev: () => void;
}

/**
 * Desktop integration: tray actions + tooltip, close-to-tray, and the
 * compact always-on-top mini player.
 */
export function useDesktop(track: Item | null, closeToTray: boolean, handlers: Handlers) {
  const [trayAvailable, setTrayAvailable] = useState(false);
  const [mini, setMini] = useState(false);
  const full = useRef<LogicalSize | null>(null);
  const h = useRef(handlers);
  h.current = handlers;

  useEffect(() => {
    invoke<boolean>("tray_available")
      .then(setTrayAvailable)
      .catch(() => setTrayAvailable(false));
    let un: (() => void) | undefined;
    let dead = false;
    listen<string>("tray", (e) => {
      if (e.payload === "toggle") h.current.toggle();
      else if (e.payload === "next") h.current.next();
      else if (e.payload === "prev") h.current.prev();
    })
      .then((u) => (dead ? u() : (un = u)))
      .catch(() => {});
    return () => {
      dead = true;
      un?.();
    };
  }, []);

  useEffect(() => {
    invoke("set_close_to_tray", { enabled: closeToTray }).catch(() => {});
  }, [closeToTray]);

  useEffect(() => {
    const text = track ? `${track.title} — ${artistLabel(track)}` : "";
    invoke("set_tray_tooltip", { text }).catch(() => {});
  }, [track]);

  const enterMini = useCallback(async () => {
    try {
      const w = getCurrentWindow();
      const scale = await w.scaleFactor();
      full.current = (await w.innerSize()).toLogical(scale);
      await w.setMinSize(new LogicalSize(320, 96));
      await w.setDecorations(false);
      await w.setAlwaysOnTop(true);
      await w.setSize(new LogicalSize(MINI.width, MINI.height));
      setMini(true);
    } catch (e) {
      console.error("mini player failed", e);
    }
  }, []);

  const exitMini = useCallback(async () => {
    try {
      const w = getCurrentWindow();
      await w.setAlwaysOnTop(false);
      await w.setDecorations(true);
      const size = full.current ?? new LogicalSize(1220, 800);
      await w.setSize(new LogicalSize(Math.max(size.width, FULL_MIN.width), Math.max(size.height, FULL_MIN.height)));
      await w.setMinSize(new LogicalSize(FULL_MIN.width, FULL_MIN.height));
    } catch (e) {
      console.error("leaving mini player failed", e);
    }
    setMini(false);
  }, []);

  return { trayAvailable, mini, enterMini, exitMini };
}
