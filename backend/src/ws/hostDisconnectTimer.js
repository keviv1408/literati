'use strict';

/**
 * Host-disconnect reconnect timer.
 *
 * When the host of a private room disconnects from the lobby, a 60-second
 * grace window starts.  If the host reconnects within that window the timer
 * is cancelled.  If 60 seconds elapse without a reconnect, the expiry
 * callback fires so the room can be handled accordingly (e.g. closing the
 * room or notifying remaining players).
 *
 * A tick callback fires every TICK_INTERVAL_MS so clients can display a
 * live countdown bar.
 *
 * Design notes:
 *   - One active timer per room (identified by the uppercase room code).
 *   - startHostDisconnectTimer is idempotent: calling it a second time for the
 *     same room is a no-op and returns the existing expiry timestamp with
 *     started: false.
 *   - cancelHostDisconnectTimer is safe to call when no timer is active.
 *   - Timers call unref() so they do not prevent the process from exiting
 *     cleanly in tests.
 *
 * Wire messages emitted by callers of this module:
 *
 *   { type: 'host_disconnected', roomCode, expiresAt }
 *     Broadcast to ALL remaining clients when the host disconnects.
 *
 *   { type: 'host_disconnect_tick', roomCode, remainingMs, expiresAt }
 *     Broadcast every TICK_INTERVAL_MS during the 60-second window.
 *
 *   { type: 'host_timeout', roomCode }
 *     Broadcast to ALL remaining clients when the 60-second window expires
 *     without the host reconnecting.
 *
 *   { type: 'host_reconnected', roomCode }
 *     Broadcast to ALL clients when the host reconnects within the window.
 *
 * Usage:
 *   const {
 *     startHostDisconnectTimer,
 *     cancelHostDisconnectTimer,
 *   } = require('./hostDisconnectTimer');
 *
 *   // When host disconnects (and other players remain):
 *   const { started, expiresAt } = startHostDisconnectTimer(
 *     roomCode,
 *     (code, remainingMs, exp) => broadcast(code, { type: 'host_disconnect_tick', ... }),
 *     (code) => broadcast(code, { type: 'host_timeout', roomCode: code }),
 *   );
 *   if (started) broadcast(roomCode, { type: 'host_disconnected', roomCode, expiresAt });
 *
 *   // When host reconnects within the window:
 *   const wasCancelled = cancelHostDisconnectTimer(roomCode);
 *   if (wasCancelled) broadcast(roomCode, { type: 'host_reconnected', roomCode });
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Grace window (ms) for host to reconnect before the expiry fires. */
const HOST_RECONNECT_WINDOW_MS = 60_000; // 60 seconds

/** How often to invoke the tick callback for countdown UI updates. */
const TICK_INTERVAL_MS = 5_000; // 5 seconds

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TimerRecord
 * @property {ReturnType<typeof setTimeout>}   handle     - setTimeout handle (expiry).
 * @property {ReturnType<typeof setInterval>|null} tickHandle - setInterval handle (ticks), or null.
 * @property {number} expiresAt  - epoch ms when the timer will fire.
 */

/** @type {Map<string, TimerRecord>} roomCode (uppercase) → TimerRecord */
const _timers = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start the host-disconnect countdown for a room.
 *
 * If a timer is already running for this room the call is a no-op and the
 * existing expiry timestamp is returned with `started: false`.
 *
 * @param {string}    roomCode    - Room code (case-insensitive).
 * @param {Function|null} onTick  - Called every TICK_INTERVAL_MS during the
 *                                  window.  Signature: (roomCode, remainingMs, expiresAt).
 *                                  Pass null to skip tick callbacks.
 *                                  May NOT be async (only sync errors are caught).
 * @param {Function}  onExpiry    - Called when the 60-second window closes
 *                                  without a host reconnect.  Receives the
 *                                  uppercase room code as the only argument.
 *                                  May be async — Promise rejections are caught.
 * @param {number}    [timeoutMs] - Override the 60-second default (for tests).
 * @returns {{ started: boolean, expiresAt: number }}
 *   `started`   true when a new timer was created; false when one already existed.
 *   `expiresAt` epoch ms when the timer will fire.
 */
function startHostDisconnectTimer(
  roomCode,
  onTick,
  onExpiry,
  timeoutMs = HOST_RECONNECT_WINDOW_MS,
) {
  const key = roomCode.toUpperCase();

  // Idempotent: if a timer already exists, return the existing expiry.
  if (_timers.has(key)) {
    const existing = _timers.get(key);
    return { started: false, expiresAt: existing.expiresAt };
  }

  const now = Date.now();
  const expiresAt = now + timeoutMs;

  // ── Tick interval ──────────────────────────────────────────────────────────
  let tickHandle = null;
  if (typeof onTick === 'function') {
    tickHandle = setInterval(() => {
      const remaining = Math.max(0, expiresAt - Date.now());
      try {
        onTick(key, remaining, expiresAt);
      } catch (err) {
        console.error('[hostDisconnectTimer] onTick error for room', key, ':', err);
      }
    }, TICK_INTERVAL_MS);
    if (tickHandle.unref) tickHandle.unref();
  }

  // ── Expiry timeout ─────────────────────────────────────────────────────────
  const handle = setTimeout(() => {
    // Cancel the tick interval before firing the callback.
    if (tickHandle) clearInterval(tickHandle);
    // Remove from store before calling the callback so that any re-entrant
    // startHostDisconnectTimer call inside onExpiry creates a new timer.
    _timers.delete(key);

    try {
      const result = onExpiry(key);
      // Handle async callbacks without uncaught promise rejections.
      if (result && typeof result.catch === 'function') {
        result.catch((err) =>
          console.error('[hostDisconnectTimer] onExpiry error for room', key, ':', err)
        );
      }
    } catch (err) {
      console.error('[hostDisconnectTimer] onExpiry sync error for room', key, ':', err);
    }
  }, timeoutMs);

  if (handle.unref) handle.unref();

  _timers.set(key, { handle, tickHandle, expiresAt });

  return { started: true, expiresAt };
}

/**
 * Cancel the host-disconnect timer for a room.
 *
 * Typically called when the host reconnects within the 60-second window.
 * Safe to call when no timer is active; returns false in that case.
 *
 * @param {string} roomCode
 * @returns {boolean} true if a timer was found and cancelled; false otherwise.
 */
function cancelHostDisconnectTimer(roomCode) {
  const key = roomCode.toUpperCase();
  const record = _timers.get(key);
  if (!record) return false;

  clearTimeout(record.handle);
  if (record.tickHandle) clearInterval(record.tickHandle);
  _timers.delete(key);
  return true;
}

/**
 * Return the milliseconds remaining until the host-disconnect timer fires.
 *
 * @param {string} roomCode
 * @returns {number|null} ms remaining (clamped to 0), or null if no timer is active.
 */
function getHostDisconnectTimerRemaining(roomCode) {
  const record = _timers.get(roomCode.toUpperCase());
  if (!record) return null;
  return Math.max(0, record.expiresAt - Date.now());
}

/**
 * Return whether a host-disconnect timer is currently active for a room.
 *
 * @param {string} roomCode
 * @returns {boolean}
 */
function isHostDisconnectTimerActive(roomCode) {
  return _timers.has(roomCode.toUpperCase());
}

/**
 * Return the epoch-ms expiry timestamp for a room's active timer.
 *
 * @param {string} roomCode
 * @returns {number|null} epoch ms, or null if no timer is active.
 */
function getHostDisconnectTimerExpiry(roomCode) {
  const record = _timers.get(roomCode.toUpperCase());
  return record ? record.expiresAt : null;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Cancel all active timers and clear the store.
 * Call in afterEach/afterAll to prevent timer leakage between test suites.
 */
function _clearAllTimers() {
  for (const record of _timers.values()) {
    clearTimeout(record.handle);
    if (record.tickHandle) clearInterval(record.tickHandle);
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
  HOST_RECONNECT_WINDOW_MS,
  TICK_INTERVAL_MS,

  // Core API
  startHostDisconnectTimer,
  cancelHostDisconnectTimer,
  getHostDisconnectTimerRemaining,
  isHostDisconnectTimerActive,
  getHostDisconnectTimerExpiry,

  // Test helpers
  _clearAllTimers,
  _getTimerStore,
};
