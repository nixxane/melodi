import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { BackendStatus } from "../types";
import { LANGUAGES, REGIONS, THEMES, useSettings } from "../lib/useSettings";
import type { TextSize } from "../lib/useSettings";

interface Props {
  autoplay: boolean;
  onAutoplay: (on: boolean) => void;
  discord: { available: boolean; enabled: boolean; setEnabled: (on: boolean) => void };
  onCheckUpdates: () => Promise<"found" | "none" | "error">;
  status: BackendStatus | null;
  /** Called after language/region changed (to reload shelves). */
  onLocaleChange: (hl: string, gl: string) => void;
  data: {
    recentCount: number;
    hiddenCount: number;
    historyCount: number;
    clearRecent: () => void;
    unhideAll: () => void;
    clearHistory: () => void;
  };
}

const REPO = "https://github.com/nixxane/melodi";

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      className={`kbtn checkbox ${on ? "on" : ""}`}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      [{on ? "x" : " "}] {label}
    </button>
  );
}

/** A destructive action that needs a second click within a few seconds. */
function ConfirmButton({ label, onConfirm, disabled }: { label: string; onConfirm: () => void; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`kbtn danger ${armed ? "armed" : ""}`}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? "really?" : label}
    </button>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label">
        <span>{label}</span>
        {hint ? <span className="set-hint">{hint}</span> : null}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

export function SettingsView({
  autoplay,
  onAutoplay,
  discord,
  onCheckUpdates,
  status,
  onLocaleChange,
  data,
}: Props) {
  const { settings, update } = useSettings();
  const [version, setVersion] = useState<string>("");
  const [checking, setChecking] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(""));
  }, []);

  const setLocale = (patch: { language?: string; region?: string }) => {
    const hl = patch.language ?? settings.language;
    const gl = patch.region ?? settings.region;
    update({ language: hl, region: gl });
    onLocaleChange(hl, gl);
  };

  const check = async () => {
    setChecking("checking…");
    const r = await onCheckUpdates();
    setChecking(r === "found" ? "update available ↙" : r === "none" ? "you're up to date" : "couldn't check (offline?)");
  };

  const open = (url: string) => openUrl(url).catch(() => {});

  return (
    <div className="settings fade-in">
      <section className="set-section">
        <h2 className="view-title">appearance</h2>
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={settings.theme === t.id}
              className={`theme-card nav-target ${settings.theme === t.id ? "on" : ""}`}
              onClick={() => update({ theme: t.id })}
            >
              <span className="theme-swatch" aria-hidden="true">
                {t.swatch.map((c) => (
                  <span key={c} style={{ background: c }} />
                ))}
              </span>
              <span className="theme-name">
                {settings.theme === t.id ? "> " : "  "}
                {t.name}
              </span>
              <span className="set-hint">{t.note}</span>
            </button>
          ))}
        </div>
        <Row label="scanlines" hint="CRT-style lines over the window and artwork">
          <Toggle on={settings.scanlines} onChange={(v) => update({ scanlines: v })} label="scanlines" />
        </Row>
        <Row label="text size">
          {(["small", "normal", "large"] as TextSize[]).map((s) => (
            <button
              key={s}
              className={`kbtn ${settings.textSize === s ? "on" : ""}`}
              aria-pressed={settings.textSize === s}
              onClick={() => update({ textSize: s })}
            >
              {s}
            </button>
          ))}
        </Row>
      </section>

      <section className="set-section">
        <h2 className="view-title">playback</h2>
        <Row label="autoplay" hint="keep playing similar songs when the queue runs out">
          <Toggle on={autoplay} onChange={onAutoplay} label="autoplay" />
        </Row>
        <Row label="restore session" hint="reopen your last queue (paused) when melodi starts">
          <Toggle
            on={settings.restoreSession}
            onChange={(v) => update({ restoreSession: v })}
            label="restore on startup"
          />
        </Row>
      </section>

      <section className="set-section">
        <h2 className="view-title">region &amp; language</h2>
        <Row label="region" hint="which country's charts, shelves and search results you see">
          <select
            className="set-select"
            value={settings.region}
            onChange={(e) => setLocale({ region: e.target.value })}
          >
            {REGIONS.map(([code, name]) => (
              <option key={code} value={code}>
                {name} ({code})
              </option>
            ))}
          </select>
        </Row>
        <Row label="language" hint="language of shelf titles and labels from YouTube Music">
          <select
            className="set-select"
            value={settings.language}
            onChange={(e) => setLocale({ language: e.target.value })}
          >
            {LANGUAGES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </Row>
      </section>

      <section className="set-section">
        <h2 className="view-title">integrations</h2>
        <Row
          label="discord"
          hint={discord.available ? "show “listening to <artist>” on your discord profile" : "not available in this build"}
        >
          <Toggle
            on={discord.available && discord.enabled}
            onChange={(v) => discord.available && discord.setEnabled(v)}
            label="rich presence"
          />
        </Row>
        <Row label="updates" hint="check github for new versions on launch and every few hours">
          <Toggle on={settings.checkUpdates} onChange={(v) => update({ checkUpdates: v })} label="check automatically" />
          <button className="kbtn" onClick={check} disabled={checking === "checking…"}>
            check now
          </button>
          {checking ? <span className="set-hint">{checking}</span> : null}
        </Row>
      </section>

      <section className="set-section">
        <h2 className="view-title">your data</h2>
        <p className="set-hint set-note">everything below is stored only on this computer.</p>
        <Row label="recently played" hint={`${data.recentCount} songs`}>
          <ConfirmButton label="clear" onConfirm={data.clearRecent} disabled={!data.recentCount} />
        </Row>
        <Row label="hidden artists" hint={`${data.hiddenCount} hidden from “your artists”`}>
          <ConfirmButton label="unhide all" onConfirm={data.unhideAll} disabled={!data.hiddenCount} />
        </Row>
        <Row label="search history" hint={`${data.historyCount} searches`}>
          <ConfirmButton label="clear" onConfirm={data.clearHistory} disabled={!data.historyCount} />
        </Row>
      </section>

      <section className="set-section">
        <h2 className="view-title">about</h2>
        <div className="about">
          <div>
            <span className="accent">melodi</span> {version ? `v${version}` : ""}
            <span className="dim"> · free software, GPL-3.0-or-later</span>
          </div>
          <div className="dim">
            yt-dlp {status?.version ?? "—"} · lyrics by LRCLIB / YouTube Music
          </div>
          <div className="about-links">
            <button className="kbtn" onClick={() => open(REPO)}>
              github
            </button>
            <button className="kbtn" onClick={() => open(`${REPO}/releases`)}>
              releases
            </button>
            <button className="kbtn" onClick={() => open(`${REPO}/issues`)}>
              report a bug
            </button>
            <button className="kbtn play-btn" onClick={() => open("https://ko-fi.com/nix100")}>
              ♥︎ support on ko-fi
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
