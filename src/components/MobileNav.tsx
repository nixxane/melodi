import type { View } from "../types";

interface Props {
  view: View | null;
  libraryOpen: boolean;
  settingsOpen: boolean;
  queueCount: number;
  onNavigate: (v: View) => void;
  onLibrary: () => void;
  onSettings: () => void;
}

/** The phone layout's bottom tab bar (the sidebar becomes the "library" drawer). */
export function MobileNav({ view, libraryOpen, settingsOpen, queueCount, onNavigate, onLibrary, onSettings }: Props) {
  const tab = (label: string, glyph: string, active: boolean, onClick: () => void, badge?: number) => (
    <button className={`mnav-tab ${active ? "active" : ""}`} onClick={onClick} aria-current={active ? "page" : undefined}>
      <span className="mnav-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="mnav-label">
        {label}
        {badge ? <span className="mnav-badge"> {badge}</span> : null}
      </span>
    </button>
  );
  const page = !libraryOpen && !settingsOpen;
  return (
    <nav className="mobile-nav" aria-label="Main">
      {tab("home", "⌂", page && view === "home", () => onNavigate("home"))}
      {tab("search", "/", page && view === "search", () => onNavigate("search"))}
      {tab("library", "≡", libraryOpen, onLibrary)}
      {tab("queue", "☰", page && view === "queue", () => onNavigate("queue"), queueCount)}
      {tab("settings", "⚙", !libraryOpen && settingsOpen, onSettings)}
    </nav>
  );
}
