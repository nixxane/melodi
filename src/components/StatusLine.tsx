import type { BackendStatus } from "../types";

interface Props {
  view: string;
  isPlaying: boolean;
  hasTrack: boolean;
  isLoading: boolean;
  queueCount: number;
  volume: number;
  status: BackendStatus | null;
  settingUp: boolean;
}

const HINTS: [string, string][] = [
  ["spc", "play"],
  ["←→", "seek"],
  ["⇧←→", "skip"],
  ["j/k", "move"],
  ["/", "search"],
  ["1-3", "views"],
  ["l", "lyrics"],
  ["⌫", "back"],
  ["m", "mute"],
];

/** Vim/tmux-style status line along the bottom of the window. */
export function StatusLine({
  view,
  isPlaying,
  hasTrack,
  isLoading,
  queueCount,
  volume,
  status,
  settingUp,
}: Props) {
  const mode = isLoading ? "LOAD" : isPlaying ? "PLAY" : hasTrack ? "PAUSE" : "IDLE";
  const backend = status
    ? status.ytdlp_available
      ? `yt-dlp ${status.version ?? "ok"}`
      : "backend offline"
    : settingUp
      ? "setting up yt-dlp…"
      : "starting…";
  const backendClass = status ? (status.ytdlp_available ? "ok" : "err") : "pending";

  return (
    <div className="statusline">
      <span className={`sl-mode mode-${mode.toLowerCase()}`}>{mode}</span>
      <span className="sl-seg">{view}</span>
      <span className={`sl-seg sl-backend ${backendClass}`}>● {backend}</span>
      <span className="sl-seg">q:{queueCount}</span>
      <span className="sl-seg">vol:{Math.round(volume * 100)}%</span>
      <span className="sl-fill" />
      <span className="sl-hints">
        {HINTS.map(([k, v]) => (
          <span key={k} className="sl-hint">
            <kbd>{k}</kbd> {v}
          </span>
        ))}
      </span>
    </div>
  );
}
