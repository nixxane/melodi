import type { Update } from "@tauri-apps/plugin-updater";
import type { UpdatePhase } from "../lib/useUpdater";
import { Spinner } from "./Spinner";

interface Props {
  update: Update | null;
  phase: UpdatePhase;
  progress: number | null;
  onInstall: () => void;
  onLater: () => void;
  onOpenReleases: () => void;
}

/** "melodi 0.2.1 available · [update] [notes] [later]" */
export function UpdateBanner({ update, phase, progress, onInstall, onLater, onOpenReleases }: Props) {
  if (!update) return null;

  return (
    <div className={`update-banner ${phase === "failed" ? "error" : ""}`} role="status">
      <span className="toast-tag">{phase === "failed" ? "[ERR]" : "[UPD]"}</span>
      <span className="update-msg">
        {phase === "available" && (
          <>
            melodi <b>{update.version}</b> is available
            <span className="dim"> (you have {update.currentVersion})</span>
          </>
        )}
        {phase === "downloading" && (
          <>
            <Spinner /> downloading{progress != null ? ` ${progress}%` : "…"}
          </>
        )}
        {phase === "installing" && (
          <>
            <Spinner /> installing — melodi will restart
          </>
        )}
        {phase === "failed" && <>couldn't install automatically — get it from the download page</>}
      </span>
      {phase === "available" ? (
        <>
          <button className="kbtn play-btn" onClick={onInstall}>
            update
          </button>
          <button className="kbtn" onClick={onOpenReleases} title="Release notes">
            notes
          </button>
          <button className="kbtn" onClick={onLater}>
            later
          </button>
        </>
      ) : phase === "failed" ? (
        <>
          <button className="kbtn play-btn" onClick={onOpenReleases}>
            download page
          </button>
          <button className="kbtn" onClick={onLater}>
            close
          </button>
        </>
      ) : null}
    </div>
  );
}
