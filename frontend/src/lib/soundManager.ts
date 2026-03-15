/**
 * soundManager.ts — Comprehensive sound service for Literati game audio events.
 *
 * Synthesizes distinct audio cues for each game event using the Web Audio API.
 * No external audio files are required — all sounds are generated procedurally.
 *
 * Supported events:
 *  • card_deal         — brief soft "swoosh" when cards are distributed
 *  • ask_success       — cheerful ascending arpeggio when card request succeeds
 *  • ask_fail          — descending minor tone when card request is denied
 *  • declaration_fanfare — triumphant ascending run when a half-suit is declared
 *
 * Features:
 *  • Volume control (0.0 – 1.0) persisted to localStorage
 *  • preload() — call once on a user-gesture to unlock audio on mobile browsers
 *  • Respects the global mute preference from audio.ts
 *  • Lazy AudioContext — created on first use, reused thereafter
 *  • SSR-safe — all methods are no-ops when AudioContext is unavailable
 *  • Fail-silent — any synthesis error is swallowed; audio is non-critical
 *
 * @example
 * import { soundManager } from '@/lib/soundManager';
 *
 * // Unlock audio on the first user interaction (e.g. a button click in layout)
 * soundManager.preload();
 *
 * // Play sounds in response to game events
 * soundManager.play('card_deal');
 * soundManager.play('ask_success');
 * soundManager.play('ask_fail');
 * soundManager.play('declaration_fanfare');
 *
 * // Adjust volume (0 = silent, 1 = full)
 * soundManager.setVolume(0.5);
 * console.log(soundManager.volume); // 0.5
 */

import { isMuted } from '@/lib/audio';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All sound event names recognised by SoundManager. */
export type SoundEvent =
  | 'card_deal'
  | 'ask_success'
  | 'ask_fail'
  | 'declaration_fanfare';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** localStorage key for persisting the volume preference. */
export const VOLUME_STORAGE_KEY = 'literati:volume';

/** Default volume level (70 %). */
const DEFAULT_VOLUME = 0.7;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns the AudioContext constructor, or null in SSR / unsupported browsers. */
function getAudioContextConstructor(): (new () => AudioContext) | null {
  if (typeof window === 'undefined') return null;
  return (
    (window as Window & { AudioContext?: new () => AudioContext }).AudioContext ??
    (window as Window & { webkitAudioContext?: new () => AudioContext })
      .webkitAudioContext ??
    null
  );
}

/** Clamp a number to [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// SoundManager class
// ---------------------------------------------------------------------------

/**
 * Manages game audio synthesis with volume control and preloading.
 *
 * Use the exported singleton `soundManager` rather than constructing directly.
 */
export class SoundManager {
  /** Lazy AudioContext, created on first sound play or preload(). */
  private _ctx: AudioContext | null = null;

  /** Master volume scalar applied to all sounds (0.0 – 1.0). */
  private _volume: number;

  /** Whether preload() has been called at least once. */
  private _preloaded: boolean = false;

  constructor() {
    this._volume = this._readVolume();
  }

  // -------------------------------------------------------------------------
  // Public API — volume
  // -------------------------------------------------------------------------

  /** Current volume level (0.0 = silent, 1.0 = full). */
  get volume(): number {
    return this._volume;
  }

  /**
   * Set volume level and persist the preference.
   *
   * @param level A number in the range [0.0, 1.0].  Values outside this
   *   range are clamped automatically.
   */
  setVolume(level: number): void {
    this._volume = clamp(level, 0, 1);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(VOLUME_STORAGE_KEY, String(this._volume));
      }
    } catch {
      // Storage quota or security — fail silently.
    }
  }

  // -------------------------------------------------------------------------
  // Public API — preloading
  // -------------------------------------------------------------------------

  /**
   * Attempt to unlock / warm-up the AudioContext.
   *
   * Mobile browsers (iOS Safari in particular) require a user-gesture before
   * audio can play.  Call `preload()` inside a click or touch handler as early
   * as possible in the session so the first game sound is never suppressed.
   *
   * It is safe to call multiple times — subsequent calls are no-ops once the
   * context is running.
   */
  preload(): void {
    if (this._preloaded) return;
    this._preloaded = true;

    const ctx = this._getOrCreateContext();
    if (!ctx) return;

    // Resume a suspended context (required after autoplay policy blocks it).
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {
        // Ignore — the context will be resumed the next time play() is called.
      });
    }
  }

  // -------------------------------------------------------------------------
  // Public API — playback
  // -------------------------------------------------------------------------

  /**
   * Play a sound cue by event name.
   *
   * No-ops silently when:
   *  • The global mute preference is enabled
   *  • AudioContext is unavailable (SSR or unsupported browser)
   *  • Any synthesis error occurs
   */
  play(event: SoundEvent): void {
    switch (event) {
      case 'card_deal':
        this.playCardDeal();
        break;
      case 'ask_success':
        this.playAskSuccess();
        break;
      case 'ask_fail':
        this.playAskFail();
        break;
      case 'declaration_fanfare':
        this.playDeclarationFanfare();
        break;
      default:
        // Unknown event — ignore silently.
        break;
    }
  }

  /**
   * Brief soft "swoosh" — played when cards are dealt at game start.
   *
   * Synthesised from a short burst of band-pass filtered noise followed by
   * a quick pitch-descending triangle tone, giving the impression of a card
   * being slid across a table surface.  Total duration ≈ 120 ms.
   */
  playCardDeal(): void {
    if (isMuted() || this._volume === 0) return;

    const ctx = this._getOrCreateContext();
    if (!ctx) return;

    try {
      this._ensureRunning(ctx);
      const t = ctx.currentTime;
      const vol = this._volume;

      // --- Noise burst (band-pass) -------------------------------------------
      const bufferSize = ctx.sampleRate * 0.1; // 100 ms of noise
      const noiseBuffer = ctx.createBuffer(1, Math.ceil(bufferSize), ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      const noiseSrc = ctx.createBufferSource();
      noiseSrc.buffer = noiseBuffer;

      const bpFilter = ctx.createBiquadFilter();
      bpFilter.type = 'bandpass';
      bpFilter.frequency.setValueAtTime(3000, t);
      bpFilter.frequency.exponentialRampToValueAtTime(800, t + 0.1);
      bpFilter.Q.value = 1.2;

      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.0, t);
      noiseGain.gain.linearRampToValueAtTime(0.12 * vol, t + 0.01);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);

      noiseSrc.connect(bpFilter);
      bpFilter.connect(noiseGain);
      noiseGain.connect(ctx.destination);
      noiseSrc.start(t);
      noiseSrc.stop(t + 0.12);

      // --- Pitch-drop triangle tick ------------------------------------------
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1200, t);
      osc.frequency.exponentialRampToValueAtTime(600, t + 0.05);

      const tickGain = ctx.createGain();
      tickGain.gain.setValueAtTime(0.0, t);
      tickGain.gain.linearRampToValueAtTime(0.08 * vol, t + 0.005);
      tickGain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);

      osc.connect(tickGain);
      tickGain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.07);
    } catch {
      // Fail silently.
    }
  }

  /**
   * Cheerful ascending three-note major arpeggio — played when a card
   * request succeeds and the card is transferred to the asking player.
   *
   * Notes: C5 (523 Hz) → E5 (659 Hz) → G5 (784 Hz)
   * Total duration ≈ 350 ms.
   */
  playAskSuccess(): void {
    if (isMuted() || this._volume === 0) return;

    const ctx = this._getOrCreateContext();
    if (!ctx) return;

    try {
      this._ensureRunning(ctx);
      const t = ctx.currentTime;
      const vol = this._volume;

      // Major arpeggio: C5 → E5 → G5
      const notes: Array<{ freq: number; delay: number }> = [
        { freq: 523.25, delay: 0.0 },   // C5
        { freq: 659.25, delay: 0.1 },   // E5
        { freq: 783.99, delay: 0.2 },   // G5
      ];

      notes.forEach(({ freq, delay }) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;

        const gain = ctx.createGain();
        const start = t + delay;
        gain.gain.setValueAtTime(0.0, start);
        gain.gain.linearRampToValueAtTime(0.18 * vol, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.25);
      });
    } catch {
      // Fail silently.
    }
  }

  /**
   * Descending minor two-note tone — played when a card request is denied
   * and the turn passes to the other team.
   *
   * Notes: A4 (440 Hz) → F4 (349 Hz) with sawtooth waveform for an edgy,
   * slightly harsh quality that conveys failure without being alarming.
   * Total duration ≈ 420 ms.
   */
  playAskFail(): void {
    if (isMuted() || this._volume === 0) return;

    const ctx = this._getOrCreateContext();
    if (!ctx) return;

    try {
      this._ensureRunning(ctx);
      const t = ctx.currentTime;
      const vol = this._volume;

      // Minor descending: A4 → F4
      const notes: Array<{ freq: number; delay: number }> = [
        { freq: 440.0,  delay: 0.0 },   // A4
        { freq: 349.23, delay: 0.18 },  // F4
      ];

      notes.forEach(({ freq, delay }) => {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = freq;

        // Add a low-pass filter to soften the harsh sawtooth
        const lpFilter = ctx.createBiquadFilter();
        lpFilter.type = 'lowpass';
        lpFilter.frequency.value = 1200;

        const gain = ctx.createGain();
        const start = t + delay;
        gain.gain.setValueAtTime(0.0, start);
        gain.gain.linearRampToValueAtTime(0.12 * vol, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.22);

        osc.connect(lpFilter);
        lpFilter.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.25);
      });
    } catch {
      // Fail silently.
    }
  }

  /**
   * Triumphant five-note ascending fanfare — played when a half-suit is
   * declared (correctly or incorrectly — the fanfare plays regardless, as the
   * declaration itself is the event being celebrated).
   *
   * Notes: C4 → E4 → G4 → C5 → E5 (major triad + octave run)
   * Uses a sine wave with slight attack and sustain for a trumpet-like quality.
   * Total duration ≈ 700 ms.
   */
  playDeclarationFanfare(): void {
    if (isMuted() || this._volume === 0) return;

    const ctx = this._getOrCreateContext();
    if (!ctx) return;

    try {
      this._ensureRunning(ctx);
      const t = ctx.currentTime;
      const vol = this._volume;

      // Triumphant ascending run: C4 → E4 → G4 → C5 → E5
      const notes: Array<{ freq: number; delay: number; duration: number }> = [
        { freq: 261.63, delay: 0.0,   duration: 0.18 },  // C4
        { freq: 329.63, delay: 0.1,   duration: 0.18 },  // E4
        { freq: 392.0,  delay: 0.2,   duration: 0.18 },  // G4
        { freq: 523.25, delay: 0.32,  duration: 0.22 },  // C5
        { freq: 659.25, delay: 0.45,  duration: 0.35 },  // E5 (held longer)
      ];

      notes.forEach(({ freq, delay, duration }) => {
        // Primary sine oscillator
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;

        // Slight harmonic overtone for richness (+1 octave, quieter)
        const harmOsc = ctx.createOscillator();
        harmOsc.type = 'sine';
        harmOsc.frequency.value = freq * 2;

        const masterGain = ctx.createGain();
        const start = t + delay;
        // Attack → sustain → release envelope
        masterGain.gain.setValueAtTime(0.0, start);
        masterGain.gain.linearRampToValueAtTime(0.22 * vol, start + 0.025);
        masterGain.gain.setValueAtTime(0.22 * vol, start + duration * 0.6);
        masterGain.gain.exponentialRampToValueAtTime(0.001, start + duration);

        const harmGain = ctx.createGain();
        harmGain.gain.setValueAtTime(0.06 * vol, start);
        harmGain.gain.exponentialRampToValueAtTime(0.001, start + duration);

        osc.connect(masterGain);
        harmOsc.connect(harmGain);
        masterGain.connect(ctx.destination);
        harmGain.connect(ctx.destination);

        osc.start(start);
        osc.stop(start + duration + 0.01);
        harmOsc.start(start);
        harmOsc.stop(start + duration + 0.01);
      });
    } catch {
      // Fail silently.
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Read volume from localStorage, falling back to DEFAULT_VOLUME. */
  private _readVolume(): number {
    try {
      if (typeof localStorage === 'undefined') return DEFAULT_VOLUME;
      const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
      if (raw === null) return DEFAULT_VOLUME;
      const parsed = parseFloat(raw);
      if (isNaN(parsed)) return DEFAULT_VOLUME;
      return clamp(parsed, 0, 1);
    } catch {
      return DEFAULT_VOLUME;
    }
  }

  /** Lazily create (or return the existing) AudioContext. */
  private _getOrCreateContext(): AudioContext | null {
    if (this._ctx) return this._ctx;
    const AudioCtx = getAudioContextConstructor();
    if (!AudioCtx) return null;
    try {
      this._ctx = new AudioCtx();
      return this._ctx;
    } catch {
      return null;
    }
  }

  /**
   * If the context is suspended (e.g. due to autoplay policy), attempt to
   * resume it.  Fire-and-forget — failure is acceptable.
   */
  private _ensureRunning(ctx: AudioContext): void {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {
        // Ignore — the sound may be silent this time but will work after next
        // user gesture.
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * Application-wide SoundManager instance.
 *
 * Import this wherever game audio cues need to be triggered:
 * ```ts
 * import { soundManager } from '@/lib/soundManager';
 * soundManager.preload();          // call once on first user interaction
 * soundManager.play('ask_success');
 * soundManager.setVolume(0.5);
 * ```
 */
export const soundManager = new SoundManager();
