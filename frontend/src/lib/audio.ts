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
// Debug overlay (temporary — remove after iOS audio is fixed)
// ---------------------------------------------------------------------------
const _debugLines: string[] = [];
function _dbg(msg: string): void {
  if (typeof document === 'undefined') return;
  _debugLines.push(`${Date.now() % 100000}: ${msg}`);
  if (_debugLines.length > 15) _debugLines.shift();
  let el = document.getElementById('__audio_debug');
  if (!el) {
    el = document.createElement('div');
    el.id = '__audio_debug';
    el.style.cssText =
      'position:fixed;bottom:0;left:0;right:0;z-index:99999;' +
      'background:rgba(0,0,0,0.85);color:#0f0;font:11px/1.3 monospace;' +
      'padding:6px;max-height:40vh;overflow-y:auto;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = _debugLines.join('\n');
}

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
  _dbg('unlockGameAudio called');
  _audioUnlocked = true;
  _setupFileAudio();
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
  if (!hasUserActivatedAudio()) { _dbg('_playTones: no activation'); return; }

  const AudioCtx = getAudioContextConstructor();
  if (!AudioCtx) { _dbg('_playTones: no AudioCtx'); return; }

  try {
    const ctx = new AudioCtx();
    _dbg(`_playTones: ctx.state=${ctx.state}`);

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
 * Strategy: one shared AudioContext, pre-decoded AudioBuffers, and a
 * **persistent** touchstart/pointerdown listener that resumes the context
 * on every user interaction (not just the first).
 *
 * Why this works on iOS:
 * - iOS suspends AudioContexts when there is no recent user gesture.
 * - BufferSource.start() on a suspended context is silently dropped.
 * - By resuming the context on EVERY touch (not just once), the context
 *   stays in "running" state throughout active gameplay.
 * - Pre-decoded AudioBuffers allow synchronous start() — no async gap.
 *
 * This is the same pattern used by Howler.js for iOS Safari.
 */

/** All MP3 sound file paths. */
const _soundPaths = [
  '/sounds/askSuccess.mp3',
  '/sounds/askFail.mp3',
  '/sounds/declarationSuccess.mp3',
  '/sounds/declarationFail.mp3',
] as const;

/** Shared AudioContext for file-based playback (created once). */
let _fileCtx: AudioContext | null = null;

/** Pre-decoded AudioBuffers keyed by path. */
const _bufferCache = new Map<string, AudioBuffer>();

/** Whether setup has run. */
let _fileAudioSetUp = false;

/**
 * One-time setup: create shared AudioContext, resume it, pre-decode all
 * MP3 buffers, and install a persistent touch listener to keep the
 * context alive on iOS.
 *
 * Called from unlockGameAudio() during the first user gesture.
 */
function _setupFileAudio(): void {
  if (_fileAudioSetUp) return;
  _fileAudioSetUp = true;
  _dbg('_setupFileAudio start');

  const AudioCtx = getAudioContextConstructor();
  if (!AudioCtx) { _dbg('NO AudioCtx constructor'); return; }

  try {
    _fileCtx = new AudioCtx();
    _dbg(`ctx created, state=${_fileCtx.state}, sr=${_fileCtx.sampleRate}`);
  } catch (e) {
    _dbg(`ctx create FAILED: ${e}`);
    return;
  }

  const ctx = _fileCtx;

  // Resume immediately (we're inside a user gesture).
  if (ctx.state === 'suspended') {
    ctx.resume().then(() => _dbg(`ctx resumed → ${ctx.state}`)).catch((e) => _dbg(`resume err: ${e}`));
  }

  // Fetch + decode all MP3s into this context.
  for (const path of _soundPaths) {
    const shortPath = path.split('/').pop();
    fetch(path)
      .then((res) => {
        _dbg(`fetch ${shortPath}: ${res.status} ${res.ok ? 'OK' : 'FAIL'}`);
        return res.arrayBuffer();
      })
      .then((data) => {
        _dbg(`decode ${shortPath}: ${data.byteLength}B`);
        return ctx.decodeAudioData(data);
      })
      .then((buffer) => {
        _bufferCache.set(path, buffer);
        _dbg(`decoded ${shortPath}: dur=${buffer.duration.toFixed(2)}s`);
      })
      .catch((e) => _dbg(`ERR ${shortPath}: ${e}`));
  }

  // ── Persistent listener: resume context on every user interaction ──
  // iOS re-suspends the context after idle periods. This listener
  // ensures it is always "running" when the user is actively playing.
  // It is passive and lightweight — just a resume() call.
  const keepAlive = () => {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  };
  document.addEventListener('touchstart', keepAlive, { passive: true });
  document.addEventListener('touchend', keepAlive, { passive: true });
  document.addEventListener('pointerdown', keepAlive, { passive: true });
  document.addEventListener('pointerup', keepAlive, { passive: true });
  document.addEventListener('click', keepAlive, { passive: true });
}

/**
 * Plays a pre-decoded AudioBuffer through the shared AudioContext.
 * The buffer is played synchronously (no async gap) so iOS does not
 * have a chance to suspend the context between decode and start.
 */
function _playFile(path: string): void {
  const shortPath = path.split('/').pop();
  if (isMuted()) { _dbg(`SKIP ${shortPath}: muted`); return; }
  if (!hasUserActivatedAudio()) { _dbg(`SKIP ${shortPath}: no activation`); return; }

  const ctx = _fileCtx;
  if (!ctx) { _dbg(`SKIP ${shortPath}: no ctx`); return; }

  const buffer = _bufferCache.get(path);
  if (!buffer) { _dbg(`SKIP ${shortPath}: no buffer (cache size=${_bufferCache.size})`); return; }

  try {
    _dbg(`PLAY ${shortPath}: ctx.state=${ctx.state}`);

    // Resume just in case (no-op if already running).
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
    _dbg(`STARTED ${shortPath}`);
  } catch (e) {
    _dbg(`ERR play ${shortPath}: ${e}`);
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
