import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { loadJSON, saveJSON } from "./storage";

export const SETTINGS_KEY = "melodi.settings";

export type ThemeId = "amber" | "phosphor" | "ice" | "catppuccin" | "gruvbox" | "mono" | "paper";
export type TextSize = "small" | "normal" | "large";

export interface Settings {
  theme: ThemeId;
  scanlines: boolean;
  textSize: TextSize;
  /** Reopen the last queue (paused) when Melodi starts. */
  restoreSession: boolean;
  /** Check GitHub for new versions automatically. */
  checkUpdates: boolean;
  /** Closing the window hides Melodi to the tray (keeps playing). */
  closeToTray: boolean;
  /** YouTube Music interface language (hl) and content region (gl). */
  language: string;
  region: string;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "amber",
  scanlines: true,
  textSize: "normal",
  restoreSession: true,
  checkUpdates: true,
  closeToTray: false,
  language: "en",
  region: "US",
};

export const THEMES: { id: ThemeId; name: string; note: string; swatch: string[] }[] = [
  { id: "amber", name: "amber", note: "phosphor amber (default)", swatch: ["#0b0a08", "#f5a83c", "#e8dfcc", "#8fd694"] },
  { id: "phosphor", name: "phosphor", note: "green terminal", swatch: ["#050a06", "#3dff7a", "#c8f5d0", "#7cd6c9"] },
  { id: "ice", name: "ice", note: "cool blue", swatch: ["#070b12", "#5cc8ff", "#dbe7ff", "#b9a4ff"] },
  { id: "catppuccin", name: "catppuccin", note: "soft pastel dark", swatch: ["#1e1e2e", "#cba6f7", "#cdd6f4", "#a6e3a1"] },
  { id: "gruvbox", name: "gruvbox", note: "warm retro dark", swatch: ["#1d2021", "#fabd2f", "#ebdbb2", "#b8bb26"] },
  { id: "mono", name: "mono", note: "white on black", swatch: ["#0a0a0a", "#ffffff", "#a0a0a0", "#5c5c5c"] },
  { id: "paper", name: "paper", note: "light, for daytime", swatch: ["#f3ecdc", "#b45309", "#2a2216", "#1f6f8b"] },
];

export const LANGUAGES: [string, string][] = [
  ["en", "English"], ["tr", "Türkçe"], ["de", "Deutsch"], ["fr", "Français"], ["es", "Español"],
  ["pt", "Português"], ["it", "Italiano"], ["nl", "Nederlands"], ["pl", "Polski"], ["sv", "Svenska"],
  ["uk", "Українська"], ["ru", "Русский"], ["ar", "العربية"], ["hi", "हिन्दी"], ["id", "Bahasa Indonesia"],
  ["ja", "日本語"], ["ko", "한국어"], ["zh-TW", "中文 (繁體)"],
];

export const REGIONS: [string, string][] = [
  ["US", "United States"], ["GB", "United Kingdom"], ["CA", "Canada"], ["AU", "Australia"],
  ["TR", "Türkiye"], ["DE", "Germany"], ["FR", "France"], ["ES", "Spain"], ["IT", "Italy"],
  ["NL", "Netherlands"], ["PL", "Poland"], ["SE", "Sweden"], ["UA", "Ukraine"], ["AZ", "Azerbaijan"],
  ["BR", "Brazil"], ["MX", "Mexico"], ["AR", "Argentina"], ["IN", "India"], ["ID", "Indonesia"],
  ["JP", "Japan"], ["KR", "South Korea"], ["TW", "Taiwan"], ["SA", "Saudi Arabia"], ["EG", "Egypt"],
  ["NG", "Nigeria"], ["ZA", "South Africa"],
];

const THEME_IDS = new Set(THEMES.map((t) => t.id));

/** Read settings straight from storage (for code that runs before React state exists). */
export function readSettings(): Settings {
  const raw = loadJSON<Partial<Settings> | null>(SETTINGS_KEY, null) ?? {};
  const s = { ...DEFAULT_SETTINGS, ...raw };
  if (!THEME_IDS.has(s.theme)) s.theme = DEFAULT_SETTINGS.theme;
  return s;
}

/** Apply the visual settings to <html> (theme, text size, scanlines). */
export function applyVisuals(s: Settings) {
  const el = document.documentElement;
  el.dataset.theme = s.theme;
  el.dataset.size = s.textSize;
  el.dataset.scanlines = s.scanlines ? "on" : "off";
}

export function useSettingsState() {
  const [settings, setSettings] = useState<Settings>(readSettings);

  useEffect(() => applyVisuals(settings), [settings]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      saveJSON(SETTINGS_KEY, next);
      return next;
    });
  }, []);

  return { settings, update };
}

export type SettingsApi = ReturnType<typeof useSettingsState>;

export const SettingsContext = createContext<SettingsApi>({
  settings: DEFAULT_SETTINGS,
  update: () => {},
});

export const useSettings = () => useContext(SettingsContext);
