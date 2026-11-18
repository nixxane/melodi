import { useCallback, useEffect, useRef, useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";

export const RELEASES_URL = "https://github.com/nixxane/melodi/releases/latest";
const FIRST_CHECK_MS = 8_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export type UpdatePhase = "available" | "downloading" | "installing" | "failed";

/**
 * Checks GitHub Releases for a newer signed build and installs it on request.
 * Only runs in installed (production) builds.
 */
export function useUpdater(autoCheck = true) {
  const [update, setUpdate] = useState<Update | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>("available");
  const [progress, setProgress] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const busy = useRef(false);

  /** Returns "found", "none" or "error". */
  const runCheck = useCallback(async (manual = false): Promise<"found" | "none" | "error"> => {
    if (busy.current) return "none";
    try {
      const u = await check();
      if (u) {
        setUpdate((prev) => {
          if (manual || prev?.version !== u.version) setDismissed(false);
          return u;
        });
        setPhase("available");
        return "found";
      }
      return "none";
    } catch {
      /* offline or no release yet: try again later */
      return "error";
    }
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV || !autoCheck) return;
    const first = window.setTimeout(runCheck, FIRST_CHECK_MS);
    const every = window.setInterval(runCheck, CHECK_EVERY_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [runCheck, autoCheck]);

  const install = useCallback(async () => {
    if (!update || busy.current) return;
    busy.current = true;
    setPhase("downloading");
    let total = 0;
    let done = 0;
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          total = ev.data.contentLength ?? 0;
          setProgress(total ? 0 : null);
        } else if (ev.event === "Progress") {
          done += ev.data.chunkLength;
          if (total) setProgress(Math.min(100, Math.round((done / total) * 100)));
        } else if (ev.event === "Finished") {
          setPhase("installing");
        }
      });
      await relaunch();
    } catch (e) {
      // e.g. a .deb install, which can't replace itself: offer the download page.
      console.error("update failed", e);
      setPhase("failed");
    } finally {
      busy.current = false;
    }
  }, [update]);

  const openReleases = useCallback(() => {
    openUrl(RELEASES_URL).catch(() => {});
  }, []);

  return {
    update: dismissed ? null : update,
    phase,
    progress,
    install,
    later: () => setDismissed(true),
    openReleases,
    checkNow: () => runCheck(true),
  };
}
