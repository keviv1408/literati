/**
 * audio.ts — Browser Audio API utility for Literati game sound cues.
 *
 * Synthesizes sounds using the Web Audio API (no external audio files needed).
 * All functions are safe to call in SSR environments — they are no-ops when
 * `window` or `AudioContext` is unavailable.
 *
 * Mute preference is persisted in localStorage under the key `literati:muted`
 * so it survives page refreshes without needing a server round-trip.
 *
 * ## Sound inventory
 * | Function                 | Event                              |
 * |--------------------------|------------------------------------|
 * | playTurnChime()          | Your turn starts / repeats         |
 * | playDealSound()          | Cards are dealt at game start      |
 * | playAskSuccess()         | Card-request succeeds (got card)   |
 * | playAskFail()            | Card-request fails (no card)       |
 * | playDeclarationSuccess() | Declaration is correct             |
 * | playDeclarationFail()    | Declaration is incorrect           |
 *
 * @example
 * // Play the turn-start chime if the user is not muted:
 * import { playTurnChime } from '@/lib/audio';
 * playTurnChime();
 *
 * @example
 * // Toggle mute and read back the new state:
 * import { toggleMuted, isMuted } from '@/lib/audio';
 * const nowMuted = toggleMuted();
 * console.log(nowMuted); // true | false
 */

/** localStorage key used to persist the mute preference. */
export const MUTE_STORAGE_KEY = 'literati:muted';

// ---------------------------------------------------------------------------
// Mute preference helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the user has muted game sounds.
 * Safe to call in SSR (returns `false` when `localStorage` is unavailable).
 */
export function isMuted(): boolean {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return false;
  }
  return localStorage.getItem(MUTE_STORAGE_KEY) === 'true';
}

/**
 * Persists the given mute preference to localStorage.
 * No-op in SSR environments.
 */
export function setMuted(muted: boolean): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
    return;
  }
  localStorage.setItem(MUTE_STORAGE_KEY, muted ? 'true' : 'false');
}

/**
 * Toggles the mute preference and returns the new state.
 *
 * @returns `true` if sounds are now muted, `false` if unmuted.
 */
export function toggleMuted(): boolean {
  const next = !isMuted();
  setMuted(next);
  return next;
}

// ---------------------------------------------------------------------------
// Sound synthesis
// ---------------------------------------------------------------------------

/**
 * Resolves the best available AudioContext constructor, or `null` if Web
 * Audio API is unavailable (SSR or unsupported browser).
 */
function getAudioContextConstructor(): (new () => AudioContext) | null {
  if (typeof window === 'undefined') return null;
  // Standard + webkit prefix for older Safari
  return (
    (window as Window & { AudioContext?: new () => AudioContext }).AudioContext ??
    (window as Window & { webkitAudioContext?: new () => AudioContext })
      .webkitAudioContext ??
    null
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Plays a sequence of synthesised tones from a single AudioContext.
 * Each tone uses a linear-attack / exponential-decay envelope.
 * The AudioContext is closed automatically after all tones finish.
 *
 * @param tones  Array of `{ freq, delay, duration, peak }` descriptors.
 *               `delay` is seconds from `ctx.currentTime`.
 *               `duration` is the decay length in seconds (tone audible for ~this long).
 *               `peak` is the maximum gain (0–1, default 0.18).
 */
function _playTones(
  tones: Array<{ freq: number; delay: number; duration: number; peak?: number }>,
): void {
  const AudioCtx = getAudioContextConstructor();
  if (!AudioCtx) return;

  try {
    const ctx = new AudioCtx();

    let lastEnd = 0;

    tones.forEach(({ freq, delay, duration, peak = 0.18 }) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.value = freq;

      const t = ctx.currentTime + delay;
      // Quick linear attack
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(peak, t + 0.015);
      // Exponential decay to near-zero
      gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(t);
      osc.stop(t + duration + 0.005);

      const endSec = delay + duration + 0.005;
      if (endSec > lastEnd) lastEnd = endSec;
    });

    // Release the AudioContext after all tones have finished.
    setTimeout(() => {
      ctx.close().catch(() => {
        // Ignore close errors — context may already be garbage-collected.
      });
    }, lastEnd * 1000 + 50);
  } catch {
    // Fail silently — audio is always optional.
  }
}

// ---------------------------------------------------------------------------
// Sound synthesis
// ---------------------------------------------------------------------------

/**
 * Plays a short ascending two-tone chime using the Web Audio API.
 *
 * The chime is synthesised from two sine-wave oscillators tuned to E5 (659 Hz)
 * and G#5 (831 Hz), offset by 120 ms.  Each tone uses a quick linear attack
 * (20 ms) followed by an exponential decay (~350 ms) for a natural bell-like
 * quality.  Total audible duration ≈ 500 ms.
 *
 * Silent no-ops when:
 *  • `isMuted()` returns `true`
 *  • Running in an SSR environment (no `window`)
 *  • `AudioContext` is not available in the browser
 *  • Any error occurs during AudioContext setup (fail-silent)
 */
export function playTurnChime(): void {
  if (isMuted()) return;
  _playTones([
    { freq: 659.25, delay: 0.00, duration: 0.35 },
    { freq: 830.61, delay: 0.12, duration: 0.35 },
  ]);
}

/**
 * Plays a soft card-deal sound at game start.
 *
 * Three descending tones (E4 → D4 → C4) played in rapid succession suggest
 * cards being distributed around the table.  Total audible duration ≈ 300 ms.
 *
 * Silent no-op when muted, SSR, or AudioContext unavailable.
 */
export function playDealSound(): void {
  if (isMuted()) return;
  _playTones([
    { freq: 329.63, delay: 0.00, duration: 0.18, peak: 0.14 },
    { freq: 293.66, delay: 0.07, duration: 0.18, peak: 0.12 },
    { freq: 261.63, delay: 0.14, duration: 0.20, peak: 0.10 },
  ]);
}

/**
 * Plays a positive confirmation sound when a card request succeeds.
 *
 * Two-tone ascending: G5 → B5 (784 Hz → 988 Hz) — brighter and higher-pitched
 * than the turn chime to convey success.  Total audible duration ≈ 300 ms.
 *
 * Silent no-op when muted, SSR, or AudioContext unavailable.
 */
export function playAskSuccess(): void {
  if (isMuted()) return;
  _playTones([
    { freq: 783.99, delay: 0.00, duration: 0.20, peak: 0.15 },
    { freq: 987.77, delay: 0.08, duration: 0.25, peak: 0.15 },
  ]);
}

/**
 * Plays a negative sound when a card request fails (opponent doesn't hold it).
 *
 * Two-tone descending: E4 → C4 (330 Hz → 262 Hz) — lower pitched and falling
 * to convey disappointment.  Total audible duration ≈ 300 ms.
 *
 * Silent no-op when muted, SSR, or AudioContext unavailable.
 */
export function playAskFail(): void {
  if (isMuted()) return;
  _playTones([
    { freq: 329.63, delay: 0.00, duration: 0.22, peak: 0.14 },
    { freq: 261.63, delay: 0.10, duration: 0.25, peak: 0.13 },
  ]);
}

/**
 * Plays a triumphant fanfare when a declaration is correct.
 *
 * Four-note ascending major arpeggio: C5 → E5 → G5 → C6
 * (523 → 659 → 784 → 1047 Hz) with a celebratory feel.
 * Total audible duration ≈ 600 ms.
 *
 * Silent no-op when muted, SSR, or AudioContext unavailable.
 */
export function playDeclarationSuccess(): void {
  if (isMuted()) return;
  _playTones([
    { freq:  523.25, delay: 0.00, duration: 0.22, peak: 0.16 },
    { freq:  659.25, delay: 0.09, duration: 0.22, peak: 0.16 },
    { freq:  783.99, delay: 0.18, duration: 0.22, peak: 0.16 },
    { freq: 1046.50, delay: 0.27, duration: 0.35, peak: 0.18 },
  ]);
}

/**
 * Plays a somber descending motif when a declaration is incorrect.
 *
 * Three-note descending minor pattern: A4 → F4 → D4
 * (440 → 349 → 294 Hz) — descending and minor to convey failure.
 * Total audible duration ≈ 450 ms.
 *
 * Silent no-op when muted, SSR, or AudioContext unavailable.
 */
export function playDeclarationFail(): void {
  if (isMuted()) return;
  _playTones([
    { freq: 440.00, delay: 0.00, duration: 0.22, peak: 0.15 },
    { freq: 349.23, delay: 0.10, duration: 0.22, peak: 0.14 },
    { freq: 293.66, delay: 0.20, duration: 0.28, peak: 0.13 },
  ]);
}
