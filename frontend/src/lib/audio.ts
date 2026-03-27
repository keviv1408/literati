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

/** Whether a real user gesture has unlocked Web Audio for this page session. */
let _audioUnlocked = false;

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

/**
 * Mark the current page session as user-activated for Web Audio.
 *
 * Call this from a trusted user gesture (click, pointerdown, keydown) before
 * attempting to play synthesized game sounds. This prevents Chrome autoplay
 * warnings caused by creating AudioContexts before the page is activated.
 */
export function unlockGameAudio(): void {
  _audioUnlocked = true;
  _warmUpFileAudio();
}

function hasUserActivatedAudio(): boolean {
  if (_audioUnlocked) return true;
  if (typeof navigator === 'undefined') return false;

  const nav = navigator as Navigator & {
    userActivation?: { hasBeenActive?: boolean; isActive?: boolean };
  };

  return Boolean(nav.userActivation?.hasBeenActive || nav.userActivation?.isActive);
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
  if (!hasUserActivatedAudio()) return;

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
// File-based audio playback (Web Audio API — mobile-safe)
// ---------------------------------------------------------------------------

/**
 * Uses a single shared AudioContext + pre-decoded AudioBuffers so that sounds
 * triggered from WebSocket callbacks (non-user-gesture) play reliably on
 * iOS Safari and mobile Chrome. The AudioContext is resumed once during the
 * first user gesture (unlockGameAudio → _warmUpFileAudio), after which
 * BufferSource nodes can fire from any execution context.
 */

/** All MP3 sound file paths. */
const _soundPaths = [
  '/sounds/askSuccess.mp3',
  '/sounds/askFail.mp3',
  '/sounds/declarationSuccess.mp3',
  '/sounds/declarationFail.mp3',
] as const;

/** Shared AudioContext for file-based playback (created lazily). */
let _fileCtx: AudioContext | null = null;

/** Decoded AudioBuffers keyed by path. */
const _bufferCache = new Map<string, AudioBuffer>();

/** Whether buffers are currently being fetched (prevents duplicate fetches). */
let _buffersLoading = false;

/** Get or create the shared AudioContext for file playback. */
function _getFileCtx(): AudioContext | null {
  if (_fileCtx) return _fileCtx;
  const AudioCtx = getAudioContextConstructor();
  if (!AudioCtx) return null;
  try {
    _fileCtx = new AudioCtx();
    return _fileCtx;
  } catch {
    return null;
  }
}

/**
 * Fetch and decode all MP3 files into AudioBuffers.
 * Called once during unlockGameAudio so buffers are ready before any
 * WebSocket event needs them.
 */
function _preloadBuffers(): void {
  if (_buffersLoading) return;
  _buffersLoading = true;

  const ctx = _getFileCtx();
  if (!ctx) return;

  for (const path of _soundPaths) {
    if (_bufferCache.has(path)) continue;
    fetch(path)
      .then((res) => res.arrayBuffer())
      .then((data) => ctx.decodeAudioData(data))
      .then((buffer) => {
        _bufferCache.set(path, buffer);
      })
      .catch(() => {
        // Fail silently — audio is always optional.
      });
  }
}

/** Interval handle for the keep-alive silent ping. */
let _keepAliveInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Play a silent buffer every 4 s to prevent iOS from suspending the
 * AudioContext due to inactivity. Started once during warm-up.
 */
function _startKeepAlive(ctx: AudioContext): void {
  if (_keepAliveInterval) return;

  // Create a tiny silent buffer (1 sample of silence).
  const silentBuffer = ctx.createBuffer(1, 1, ctx.sampleRate);

  _keepAliveInterval = setInterval(() => {
    try {
      if (ctx.state === 'closed') {
        if (_keepAliveInterval) clearInterval(_keepAliveInterval);
        _keepAliveInterval = null;
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = silentBuffer;
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      // Fail silently.
    }
  }, 4000);
}

/**
 * Resume the shared AudioContext (must be called from a user gesture on iOS)
 * and kick off buffer preloading + keep-alive.
 */
function _warmUpFileAudio(): void {
  const ctx = _getFileCtx();
  if (!ctx) return;

  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }

  // Play a silent buffer immediately to fully unlock the context on iOS.
  try {
    const silentBuffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    const src = ctx.createBufferSource();
    src.buffer = silentBuffer;
    src.connect(ctx.destination);
    src.start(0);
  } catch {
    // Fail silently.
  }

  _startKeepAlive(ctx);
  _preloadBuffers();
}

/**
 * Ensure the AudioContext is running, then play the buffer.
 * If the context needs resuming (iOS re-suspended it), we await resume
 * before starting playback so the source.start() is not silently dropped.
 */
function _playBuffer(ctx: AudioContext, buffer: AudioBuffer): void {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);

  if (ctx.state === 'running') {
    source.start(0);
  } else {
    // Context is suspended — resume first, then start.
    ctx.resume().then(() => {
      source.start(0);
    }).catch(() => {});
  }
}

/**
 * Plays a pre-decoded AudioBuffer through the shared AudioContext.
 * Handles suspended-context recovery so sounds play reliably from
 * WebSocket callbacks on mobile browsers.
 */
function _playFile(path: string): void {
  if (isMuted()) return;
  if (!hasUserActivatedAudio()) return;

  try {
    const ctx = _getFileCtx();
    if (!ctx) return;

    const buffer = _bufferCache.get(path);
    if (!buffer) return;

    _playBuffer(ctx, buffer);
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
 * Plays a cinematic card-deal sound at game start.
 *
 * Two phases matching the visual animation:
 * 1. Gather/riffle: low rumble build-up with a bright sweep
 * 2. Deal: rapid descending flicks suggesting cards leaving the deck
 *
 * Total audible duration ≈ 1.2 s. Silent no-op when muted/SSR.
 */
export function playDealSound(): void {
  if (isMuted()) return;
  _playTones([
    // Gather rumble — low, building
    { freq: 130.81, delay: 0.00, duration: 0.35, peak: 0.06 },
    { freq: 164.81, delay: 0.15, duration: 0.30, peak: 0.08 },
    // Riffle sweep — ascending bright tone
    { freq: 523.25, delay: 0.40, duration: 0.20, peak: 0.10 },
    { freq: 659.25, delay: 0.50, duration: 0.18, peak: 0.08 },
    // Deal flicks — rapid descending
    { freq: 440.00, delay: 0.70, duration: 0.10, peak: 0.12 },
    { freq: 392.00, delay: 0.78, duration: 0.10, peak: 0.11 },
    { freq: 349.23, delay: 0.86, duration: 0.10, peak: 0.10 },
    { freq: 329.63, delay: 0.94, duration: 0.10, peak: 0.09 },
    { freq: 293.66, delay: 1.02, duration: 0.12, peak: 0.08 },
    { freq: 261.63, delay: 1.10, duration: 0.14, peak: 0.07 },
  ]);
}

/**
 * Plays a positive confirmation sound when a card request succeeds.
 * Silent no-op when muted, SSR, or AudioContext unavailable.
 */
export function playAskSuccess(): void {
  _playFile('/sounds/askSuccess.mp3');
}

/**
 * Plays a negative sound when a card request fails (opponent doesn't hold it).
 * Silent no-op when muted, SSR, or AudioContext unavailable.
 */
export function playAskFail(): void {
  _playFile('/sounds/askFail.mp3');
}

/**
 * Plays a triumphant fanfare when a declaration is correct.
 * Silent no-op when muted, SSR, or AudioContext unavailable.
 */
export function playDeclarationSuccess(): void {
  _playFile('/sounds/declarationSuccess.mp3');
}

/**
 * Plays a somber descending motif when a declaration is incorrect.
 * Silent no-op when muted, SSR, or AudioContext unavailable.
 */
export function playDeclarationFail(): void {
  _playFile('/sounds/declarationFail.mp3');
}
