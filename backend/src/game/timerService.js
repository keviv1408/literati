'use strict';

/**
 * Game countdown timer service.
 *
 * Provides a unified, testable API for tracking remaining seconds during the
 * two timed phases of a Literature turn:
 *
 *   'turn'        — 30 seconds for a human player to initiate a card request
 *   'declaration' — 60 seconds for the declaring player to assign all 6 cards
 *
 * For each active timer the service:
 *   1. Broadcasts `timer_start`     immediately via broadcastFn (phase, playerId,
 *                                   durationMs, expiresAt)
 *   2. Broadcasts `timer_tick`      every TICK_INTERVAL_MS (1 second) with
 *                                   remainingMs, remainingS, and expiresAt so
 *                                   clients can keep a pixel-accurate countdown
 *   3. Broadcasts `timer_threshold` ONCE when ≤ TIMER_THRESHOLD_S (10) seconds
 *                                   remain — lets clients trigger a visual/audio
 *                                   urgency cue exactly once per timer lifecycle
 *   4. Calls onExpiry(roomCode, playerId) when the timer fires
 *
 * Both players AND spectators receive all three broadcast types because the
 * broadcastFn is expected to be `broadcastToGame()`, which iterates over all
 * registered WebSocket connections for a room (players + spectators).
 *
 * Design notes:
 *   - One active countdown timer per room (keyed by roomCode).  Starting a new
 *     timer automatically cancels any pre-existing one for the same room.
 *   - cancelCountdownTimer() is idempotent.
 *   - All Node.js timer handles are .unref()'d so pending timers do not prevent
 *     the process from exiting cleanly during tests.
 *   - The module has NO dependency on gameStore, gameSocketServer, or any other
 *     game-domain module — it only needs the broadcastFn and onExpiry callbacks
 *     injected at call-site.  This makes it easy to unit-test in isolation.
 *
 * Usage:
 *   const timerService = require('./timerService');
 *
 *   // Start a 30-second turn timer:
 *   timerService.startCountdownTimer(
 *     roomCode, 'turn', playerId, 30_000,
 *     (rc, data) => broadcastToGame(rc, data),
 *     (rc, pid) => executeTimedOutTurn(rc, pid),
 *   );
 *
 *   // Cancel it:
 *   timerService.cancelCountdownTimer(roomCode);
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often (ms) the service fires tick events to all room connections. */
const TICK_INTERVAL_MS = 1_000; // 1 second — gives pixel-accurate countdown UI

/**
 * When remainingS falls to this value or below, a `timer_threshold` event is
 * broadcast once per timer lifecycle so clients can trigger urgency cues.
 */
const TIMER_THRESHOLD_S = 10;

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TimerRecord
 * @property {ReturnType<typeof setInterval>}  tickId         - Interval ID for tick events
 * @property {ReturnType<typeof setTimeout>}   timerId        - Expiry timeout ID
 * @property {number}  expiresAt      - Epoch ms when the timer fires
 * @property {string}  phase          - 'turn' | 'declaration'
 * @property {string}  playerId       - Active player whose turn is ticking down
 * @property {boolean} thresholdFired - true once the ≤10 s threshold event has been sent
 */

/** @type {Map<string, TimerRecord>} roomCode → TimerRecord */
const _timers = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a countdown timer for a room.
 *
 * If a timer is already running for this room it is cancelled before the new
 * one starts (idempotent replacement).
 *
 * @param {string}   roomCode    - Room identifier (case-sensitive; caller is responsible for normalisation).
 * @param {string}   phase       - 'turn' | 'declaration'
 * @param {string}   playerId    - The player whose turn is ticking down.
 * @param {number}   durationMs  - Duration in milliseconds (e.g. 30_000 or 60_000).
 * @param {Function} broadcastFn - fn(roomCode, data) → void — sends to ALL connections
 *                                 in the room (players + spectators).
 * @param {Function} onExpiry    - fn(roomCode, playerId) → void|Promise — called when
 *                                 the timer fires.  Async rejections are caught and logged.
 * @returns {{ expiresAt: number }} Absolute epoch-ms timestamp when the timer will fire.
 */
function startCountdownTimer(roomCode, phase, playerId, durationMs, broadcastFn, onExpiry) {
  // Cancel any pre-existing timer for this room.
  cancelCountdownTimer(roomCode);

  const expiresAt = Date.now() + durationMs;

  // ── 1. Broadcast timer_start immediately ────────────────────────────────
  broadcastFn(roomCode, {
    type: 'timer_start',
    phase,
    playerId,
    durationMs,
    expiresAt,
  });

  // ── 2. Tick interval — fires every TICK_INTERVAL_MS ─────────────────────
  let thresholdFired = false;

  const tickId = setInterval(() => {
    const remaining = expiresAt - Date.now();

    if (remaining <= 0) {
      // The expiry timeout should fire momentarily; stop ticking.
      clearInterval(tickId);
      return;
    }

    const remainingS = Math.ceil(remaining / 1000);

    // ── 3. timer_threshold — fire once when ≤ TIMER_THRESHOLD_S remain ──
    if (!thresholdFired && remainingS <= TIMER_THRESHOLD_S) {
      thresholdFired = true;
      // Update the record's flag so _getTimerStore() reflects the state.
      const entry = _timers.get(roomCode);
      if (entry) entry.thresholdFired = true;

      broadcastFn(roomCode, {
        type: 'timer_threshold',
        phase,
        playerId,
        remainingMs: Math.max(0, remaining),
        remainingS,
        expiresAt,
      });
    }

    // Regular tick — always emitted (even in the same tick as threshold).
    broadcastFn(roomCode, {
      type: 'timer_tick',
      phase,
      playerId,
      remainingMs: Math.max(0, remaining),
      remainingS,
      expiresAt,
    });
  }, TICK_INTERVAL_MS);

  if (tickId.unref) tickId.unref();

  // ── 4. Expiry timeout ────────────────────────────────────────────────────
  const timerId = setTimeout(() => {
    const entry = _timers.get(roomCode);
    if (entry) clearInterval(entry.tickId);
    _timers.delete(roomCode);

    try {
      const result = onExpiry(roomCode, playerId);
      // Handle async callbacks without uncaught promise rejections.
      if (result && typeof result.catch === 'function') {
        result.catch((err) =>
          console.error('[timerService] onExpiry async error for room', roomCode, ':', err)
        );
      }
    } catch (err) {
      console.error('[timerService] onExpiry sync error for room', roomCode, ':', err);
    }
  }, durationMs);

  if (timerId.unref) timerId.unref();

  _timers.set(roomCode, {
    tickId,
    timerId,
    expiresAt,
    phase,
    playerId,
    thresholdFired: false,
  });

  return { expiresAt };
}

/**
 * Cancel an active countdown timer for a room.
 *
 * Safe to call when no timer is active; returns false in that case.
 *
 * @param {string} roomCode
 * @returns {boolean} true if a timer was found and cancelled; false otherwise.
 */
function cancelCountdownTimer(roomCode) {
  const entry = _timers.get(roomCode);
  if (!entry) return false;

  clearTimeout(entry.timerId);
  clearInterval(entry.tickId);
  _timers.delete(roomCode);
  return true;
}

/**
 * Return the milliseconds remaining until the timer fires.
 *
 * @param {string} roomCode
 * @returns {number|null} ms remaining (clamped to 0), or null if no timer is active.
 */
function getTimerRemaining(roomCode) {
  const entry = _timers.get(roomCode);
  if (!entry) return null;
  return Math.max(0, entry.expiresAt - Date.now());
}

/**
 * Return whether a countdown timer is currently active for a room.
 *
 * @param {string} roomCode
 * @returns {boolean}
 */
function isTimerActive(roomCode) {
  return _timers.has(roomCode);
}

/**
 * Return the epoch-ms expiry timestamp for a room's active timer.
 *
 * @param {string} roomCode
 * @returns {number|null} epoch ms, or null if no timer is active.
 */
function getTimerExpiry(roomCode) {
  const entry = _timers.get(roomCode);
  return entry ? entry.expiresAt : null;
}

/**
 * Return the phase ('turn' | 'declaration') for a room's active timer.
 *
 * @param {string} roomCode
 * @returns {string|null}
 */
function getTimerPhase(roomCode) {
  const entry = _timers.get(roomCode);
  return entry ? entry.phase : null;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Cancel all active timers and clear the internal store.
 *
 * Call in afterEach / afterAll to prevent timer leakage between test suites.
 */
function _clearAllTimers() {
  for (const entry of _timers.values()) {
    clearTimeout(entry.timerId);
    clearInterval(entry.tickId);
  }
  _timers.clear();
}

/**
 * Expose the raw timer store for inspection in tests.
 * Do NOT mutate the returned Map from outside this module.
 *
 * @returns {Map<string, TimerRecord>}
 */
function _getTimerStore() {
  return _timers;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  TICK_INTERVAL_MS,
  TIMER_THRESHOLD_S,

  // Core API
  startCountdownTimer,
  cancelCountdownTimer,
  getTimerRemaining,
  isTimerActive,
  getTimerExpiry,
  getTimerPhase,

  // Test helpers
  _clearAllTimers,
  _getTimerStore,
};
