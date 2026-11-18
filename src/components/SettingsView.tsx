import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { BackendStatus, CacheInfo } from "../types";
import { audioCacheInfo, clearAudioCache } from "../api";
import { EQ_FREQS, EQ_PRESETS } from "../lib/audioEngine";
import { LANGUAGES, REGIONS, THEMES, useSettings } from "../lib/useSettings";
import type { TextSize } from "../lib/useSettings";

interface Props {
  autoplay: boolean;
  onAutoplay: (on: boolean) => void;
  discord: { available: boolean; enabled: boolean; setEnabled: (on: boolean) => void };
  onCheckUpdates: () => Promise<"found" | "none" | "error">;
  status: BackendStatus | null;
  trayAvailable: boolean;
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

const CROSSFADES = [0, 2, 4, 6, 8, 10, 12];
const CACHE_SIZES: [number, string][] = [
  [0, "off"],
  [512, "512 MB"],
  [1024, "1 GB"],
  [2048, "2 GB"],
  [5120, "5 GB"],
  [10240, "10 GB"],
];
const EQ_MAX = 12;
const EQ_CELLS = 25;

const fmtBytes = (b: number) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`;
const fmtFreq = (f: number) => (f >= 1000 ? `${f / 1000}k` : `${f}`);

/** One equalizer band: a text slider from -12 to +12 dB, centred on 0. */
function EqBand({ freq, db, onChange }: { freq: number; db: number; onChange: (db: number) => void }) {
  const mid = (EQ_CELLS - 1) / 2;
  const pos = Math.round(mid + (db / EQ_MAX) * mid);
  const cells = Array.from({ length: EQ_CELLS }, (_, i) =>
    i === pos ? "●" : (i > mid && i < pos) || (i < mid && i > pos) || (i === mid && pos !== mid) ? "━" : i === mid ? "┼" : "─"
  );
  return (
    <div className="eqz-band">
      <span className="eqz-freq">{fmtFreq(freq)}Hz</span>
      <div className="ascii-range">
        <div className="ascii-bar" aria-hidden="true">
          {cells.map((c, i) => (
            <span key={i} className={c === "━" || c === "●" ? "fill" : "rest"}>
              {c}
            </span>
          ))}
        </div>
        <input
          type="range"
          min={-EQ_MAX}
          max={EQ_MAX}
          step={1}
          value={db}
          aria-label={`${fmtFreq(freq)} hertz`}
          onChange={(e) => onChange(Number(e.target.value))}
          onPointerUp={(e) => e.currentTarget.blur()}
        />
      </div>
      <span className="eqz-db">
        {db > 0 ? "+" : ""}
        {db} dB
      </span>
    </div>
  );
}

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
  trayAvailable,
  onLocaleChange,
  data,
}: Props) {
  const { settings, update } = useSettings();
  const [version, setVersion] = useState<string>("");
  const [checking, setChecking] = useState<string | null>(null);
  const [cache, setCache] = useState<CacheInfo | null>(null);
  const refreshCache = () => audioCacheInfo().then(setCache).catch(() => setCache(null));
  useEffect(() => {
    refreshCache();
  }, [settings.cacheMb]);

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
        <Row
          label="close to tray"
          hint={
            trayAvailable
              ? "closing the window keeps melodi playing in the tray; quit from the tray menu"
              : "no system tray found on this desktop"
          }
        >
          <Toggle
            on={trayAvailable && settings.closeToTray}
            onChange={(v) => trayAvailable && update({ closeToTray: v })}
            label="keep playing in tray"
          />
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
        <h2 className="view-title">sound</h2>
        <Row label="normalize volume" hint="play every song at a similar loudness, using youtube's loudness data">
          <Toggle on={settings.normalize} onChange={(v) => update({ normalize: v })} label="even out loudness" />
        </Row>
        <Row label="crossfade" hint="blend the end of each song into the next">
          {CROSSFADES.map((x) => (
            <button
              key={x}
              className={`kbtn ${settings.crossfade === x ? "on" : ""}`}
              aria-pressed={settings.crossfade === x}
              onClick={() => update({ crossfade: x })}
            >
              {x === 0 ? "off" : `${x}s`}
            </button>
          ))}
        </Row>
        <Row label="equalizer" hint="boost or cut bass, mids and treble">
          <div className="eqz">
            <div className="eqz-presets">
              {EQ_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={`kbtn ${settings.eqPreset === p.id ? "on" : ""}`}
                  aria-pressed={settings.eqPreset === p.id}
                  onClick={() => update({ eqPreset: p.id, eq: p.bands })}
                >
                  {p.name}
                </button>
              ))}
              {settings.eqPreset === "custom" ? <span className="kbtn on">custom</span> : null}
            </div>
            {EQ_FREQS.map((f, i) => (
              <EqBand
                key={f}
                freq={f}
                db={settings.eq[i] ?? 0}
                onChange={(db) => {
                  const eq = settings.eq.slice();
                  eq[i] = db;
                  const match = EQ_PRESETS.find((p) => p.bands.every((b, j) => b === eq[j]));
                  update({ eq, eqPreset: match?.id ?? "custom" });
                }}
              />
            ))}
          </div>
        </Row>
        <Row
          label="offline cache"
          hint={
            cache
              ? `songs you play are saved for instant, offline replay · ${fmtBytes(cache.bytes)} used, ${cache.songs} songs`
              : "songs you play are saved for instant, offline replay"
          }
        >
          <select
            className="set-select"
            value={settings.cacheMb}
            onChange={(e) => update({ cacheMb: Number(e.target.value) })}
          >
            {CACHE_SIZES.map(([mb, label]) => (
              <option key={mb} value={mb}>
                {label}
              </option>
            ))}
          </select>
          <ConfirmButton
            label="clear"
            disabled={!cache?.songs}
            onConfirm={() => {
              clearAudioCache().finally(refreshCache);
            }}
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
