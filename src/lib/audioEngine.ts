/**
 * Web Audio graph shared by the player:
 *
 *   deck A <audio> ─ source ─ gain A ─┐
 *                                     ├─ EQ (6 bands) ─ master gain ─ limiter ─ speakers
 *   deck B <audio> ─ source ─ gain B ─┘
 *
 * Two decks let one song fade into the next (crossfade). Each deck's gain
 * carries loudness normalization and the crossfade ramp; the master gain
 * carries the user's volume and the sleep-timer fade.
 *
 * Songs come through Melodi's local proxy, which adds the CORS headers Web
 * Audio needs. If the graph can't be built, the decks still play, with the
 * volume applied to the elements directly.
 *
 * Phones get no graph at all ("mobile audio mode"): iOS and some Android
 * browsers suspend an AudioContext once the app is in the background, which
 * would silence the music. Plain <audio> keeps playing on the lock screen, so
 * there EQ, normalization and crossfade are off.
 */
import { isMobile } from "./platform";


export const EQ_FREQS = [60, 150, 400, 1000, 2400, 6000, 15000];
export type EqBands = number[];
export const FLAT: EqBands = EQ_FREQS.map(() => 0);

export const EQ_PRESETS: { id: string; name: string; bands: EqBands }[] = [
  { id: "flat", name: "flat", bands: FLAT },
  { id: "bass", name: "bass boost", bands: [6, 4, 1, 0, 0, 0, 0] },
  { id: "treble", name: "treble boost", bands: [0, 0, 0, 0, 2, 4, 5] },
  { id: "vocal", name: "vocal", bands: [-2, -1, 1, 3, 3, 1, 0] },
  { id: "loud", name: "loudness", bands: [5, 3, 0, -1, 0, 3, 4] },
  { id: "warm", name: "warm", bands: [3, 2, 1, 0, -1, -2, -3] },
  { id: "bright", name: "bright", bands: [-2, -1, 0, 1, 2, 3, 3] },
];

/** Normalization bounds: turn loud songs down fully, quiet ones up a little. */
const MAX_CUT_DB = 12;
const MAX_BOOST_DB = 4;
/** Most music is louder than YouTube's reference; assume so when unknown. */
const UNKNOWN_LOUDNESS_DB = 4;

export interface Deck {
  el: HTMLAudioElement;
  gain: GainNode | null;
  /** Normalization gain (linear). */
  norm: number;
}

class Engine {
  ctx: AudioContext | null = null;
  decks: [Deck, Deck];
  private eq: BiquadFilterNode[] = [];
  private master: GainNode | null = null;
  private volume = 1;
  private fade = 1;
  private normalize = true;

  constructor() {
    const mk = (): Deck => {
      const el = new Audio();
      el.preload = "auto";
      el.crossOrigin = "anonymous";
      return { el, gain: null, norm: 1 };
    };
    this.decks = [mk(), mk()];
    if (isMobile) {
      this.applyMaster();
      return;
    }
    try {
      const ctx = new AudioContext({ latencyHint: "playback" });
      const master = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      // A brick-wall-ish limiter: only catches peaks pushed over by EQ / boost.
      limiter.threshold.value = -1;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.12;

      this.eq = EQ_FREQS.map((f, i) => {
        const b = ctx.createBiquadFilter();
        b.type = i === 0 ? "lowshelf" : i === EQ_FREQS.length - 1 ? "highshelf" : "peaking";
        b.frequency.value = f;
        b.Q.value = 1.1;
        b.gain.value = 0;
        return b;
      });
      for (let i = 0; i < this.eq.length - 1; i++) this.eq[i].connect(this.eq[i + 1]);
      this.eq[this.eq.length - 1].connect(master);
      master.connect(limiter);
      limiter.connect(ctx.destination);

      for (const d of this.decks) {
        const src = ctx.createMediaElementSource(d.el);
        d.gain = ctx.createGain();
        src.connect(d.gain);
        d.gain.connect(this.eq[0]);
      }
      this.ctx = ctx;
      this.master = master;
    } catch (e) {
      console.warn("Web Audio unavailable; EQ/normalization/crossfade off", e);
      this.ctx = null;
    }
    this.applyMaster();
  }

  get available() {
    return this.ctx != null;
  }

  /** Browsers start contexts suspended until there's been user input. */
  resume() {
    if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {});
  }

  setVolume(v: number) {
    this.volume = v;
    this.applyMaster();
  }

  setFade(f: number) {
    this.fade = f;
    this.applyMaster();
  }

  private applyMaster() {
    const v = this.volume * this.fade;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015);
      for (const d of this.decks) d.el.volume = 1;
    } else {
      for (const d of this.decks) d.el.volume = v;
    }
  }

  setEq(bands: EqBands) {
    if (!this.ctx) return;
    this.eq.forEach((b, i) => b.gain.setTargetAtTime(bands[i] ?? 0, this.ctx!.currentTime, 0.03));
  }

  setNormalize(on: boolean) {
    this.normalize = on;
  }

  /** Normalization gain for a song with YouTube loudness `db`. */
  normFor(db: number | null | undefined): number {
    if (!this.normalize || !this.ctx) return 1;
    const l = db ?? UNKNOWN_LOUDNESS_DB;
    const gainDb = Math.max(-MAX_CUT_DB, Math.min(MAX_BOOST_DB, -l));
    return Math.pow(10, gainDb / 20);
  }

  /** Set a deck's gain now, or ramp it over `secs`. */
  setDeckGain(d: Deck, value: number, secs = 0) {
    if (!d.gain || !this.ctx) return;
    const now = this.ctx.currentTime;
    const g = d.gain.gain;
    g.cancelScheduledValues(now);
    if (secs > 0) {
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(value, now + secs);
    } else {
      // Instant: callers use this only while the deck is silent or stopped.
      g.setValueAtTime(value, now);
    }
  }
}

let engine: Engine | null = null;

/** The shared engine, created on first use. */
export function audioEngine(): Engine {
  if (!engine) {
    engine = new Engine();
    // Handy for poking at the graph from devtools while developing.
    if (import.meta.env.DEV) (window as unknown as { __audio: Engine }).__audio = engine;
  }
  return engine;
}

export type AudioEngine = Engine;
