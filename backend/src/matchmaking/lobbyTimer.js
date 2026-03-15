'use strict';

/**
 * Lobby fill timer.
 *
 * Each private-room lobby that has at least one human player waiting gets a
 * 2-minute countdown.  When the timer fires, the caller's `onExpiry` callback
 * is invoked so that remaining open seats can be filled with bots and the
 * game can be started.  The timer is cancelled early if the lobby reaches
 * capacity (all human players joined) before the 2 minutes elapse.
 *
 * Design notes:
 *   - One active timer per room (identified by the uppercase room code).
 *   - startLobbyTimer is idempotent: calling it a second time for the same
 *     room is a no-op and returns the existing expiry timestamp.
 *   - cancelLobbyTimer is safe to call when no timer is active.
 *   - Timers call Node.js timer.unref() so they do not prevent the process
 *     from exiting cleanly in tests.
 *
 * Usage:
 *   const { startLobbyTimer, cancelLobbyTimer } = require('./lobbyTimer');
 *
 *   // When first player joins a room:
 *   const { started, expiresAt } = startLobbyTimer(roomCode, async (code) => {
 *     await fillWithBotsAndStartGame(code);
 *   });
 *   if (started) broadcastTimerStarted(roomCode, expiresAt);
 *
 *   // When room reaches capacity:
 *   cancelLobbyTimer(roomCode);
 *   await startGame(roomCode);
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How long to wait for human players before filling with bots. */
const LOBBY_FILL_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TimerRecord
 * @property {ReturnType<typeof setTimeout>} handle  - The setTimeout handle.
 * @property {number} startsAt   - epoch ms when the timer was created.
 * @property {number} expiresAt  - epoch ms when the timer will fire.
 */

/** @type {Map<string, TimerRecord>} roomCode (uppercase) → TimerRecord */
const _timers = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the lobby fill timer for a room.
 *
 * If a timer is already running for this room the call is a no-op and the
 * existing expiry timestamp is returned with `started: false`.
 *
 * @param {string}   roomCode    - 6-char room code (case-insensitive).
 * @param {Function} onExpiry    - Callback invoked when the timer fires.
 *                                 Receives the uppercase room code as the only
 *                                 argument.  May be async — Promise rejections
 *                                 are caught and logged.
 * @param {number}   [timeoutMs] - Override the 2-minute default (for tests).
 * @returns {{ started: boolean, expiresAt: number }}
 *   `started`   true when a new timer was created; false when one already existed.
 *   `expiresAt` epoch ms when the timer will fire.
 */
function startLobbyTimer(roomCode, onExpiry, timeoutMs = LOBBY_FILL_TIMEOUT_MS) {
  const key = roomCode.toUpperCase();

  // Idempotent: if a timer already exists, return without creating a second one.
  if (_timers.has(key)) {
    const existing = _timers.get(key);
    return { started: false, expiresAt: existing.expiresAt };
  }

  const now = Date.now();
  const expiresAt = now + timeoutMs;

  const handle = setTimeout(() => {
    // Remove from store before calling the callback so that any re-entrant
    // startLobbyTimer call inside onExpiry would create a new timer.
    _timers.delete(key);

    try {
      const result = onExpiry(key);
      // Handle async callbacks without uncaught promise rejections.
      if (result && typeof result.catch === 'function') {
        result.catch((err) =>
          console.error('[lobbyTimer] onExpiry error for room', key, ':', err)
        );
      }
    } catch (err) {
      console.error('[lobbyTimer] onExpiry sync error for room', key, ':', err);
    }
  }, timeoutMs);

  // Allow Node.js to exit even if this timer is still pending.
  if (handle.unref) handle.unref();

  _timers.set(key, { handle, startsAt: now, expiresAt });

  return { started: true, expiresAt };
}

/**
 * Cancel the lobby fill timer for a room.
 *
 * Safe to call when no timer is active; returns false in that case.
 *
 * @param {string} roomCode
 * @returns {boolean} true if a timer was found and cancelled; false otherwise.
 */
function cancelLobbyTimer(roomCode) {
  const key = roomCode.toUpperCase();
  const record = _timers.get(key);
  if (!record) return false;

  clearTimeout(record.handle);
  _timers.delete(key);
  return true;
}

/**
 * Return the milliseconds remaining until the lobby timer fires.
 *
 * @param {string} roomCode
 * @returns {number|null} ms remaining (clamped to 0), or null if no timer is active.
 */
function getLobbyTimerRemaining(roomCode) {
  const record = _timers.get(roomCode.toUpperCase());
  if (!record) return null;
  return Math.max(0, record.expiresAt - Date.now());
}

/**
 * Return whether a lobby fill timer is currently active for a room.
 *
 * @param {string} roomCode
 * @returns {boolean}
 */
function isLobbyTimerActive(roomCode) {
  return _timers.has(roomCode.toUpperCase());
}

/**
 * Return the epoch-ms expiry timestamp for a room's active timer.
 *
 * @param {string} roomCode
 * @returns {number|null} epoch ms, or null if no timer is active.
 */
function getLobbyTimerExpiry(roomCode) {
  const record = _timers.get(roomCode.toUpperCase());
  return record ? record.expiresAt : null;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Cancel all active timers and clear the store.
 * Call in afterEach / afterAll to prevent timer leakage between test suites.
 */
function _clearAllTimers() {
  for (const record of _timers.values()) {
    clearTimeout(record.handle);
  }
  _timers.clear();
}

/** Expose the raw timer store for inspection in tests. */
function _getTimerStore() {
  return _timers;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Constants
  LOBBY_FILL_TIMEOUT_MS,

  // Core API
  startLobbyTimer,
  cancelLobbyTimer,
  getLobbyTimerRemaining,
  isLobbyTimerActive,
  getLobbyTimerExpiry,

  // Test helpers
  _clearAllTimers,
  _getTimerStore,
};
