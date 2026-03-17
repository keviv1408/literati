'use strict';

/**
 * Disconnect grace-period and seat-reclaim store.
 *
 * Manages two concerns for mid-game player disconnection:
 *
 * 1. DISCONNECT GRACE TIMERS
 * When a human player disconnects from an active game, a 60-second grace
 * timer starts. If they reconnect within that window, the timer is
 * cancelled and the game continues normally. If the 60s window expires
 * without reconnection, `makeBotPermanent` is invoked to mark the seat as
 * permanently bot-controlled for the rest of the game.
 *
 * 2. RECLAIM QUEUE
 * After a player's seat is permanently bot-replaced, the original player
 * may reconnect at any time. They are placed in the reclaim queue and
 * regain control of their seat at the next turn boundary (i.e. when
 * `scheduleBotTurnIfNeeded` detects their playerId is in the queue and the
 * turn belongs to them).
 *
 * Key format for all maps: `"${ROOMCODE}:${playerId}"` (roomCode uppercased).
 *
 * Permanent bot seat assignment after 60s with mid-game reclaim.
 */

/** Grace period before a disconnected player's seat is permanently given to a bot (ms). */
const DISCONNECT_GRACE_MS = 60_000;

/**
 * Pending 60-second grace timers.
 * @type {Map<string, NodeJS.Timeout>} key: "ROOMCODE:playerId"
 */
const _disconnectTimers = new Map();

/**
 * Players waiting to reclaim their seat at the next turn boundary.
 * They reconnected after their 60s grace expired and their seat was
 * permanently replaced by a bot.
 * @type {Map<string, { since: number }>} key: "ROOMCODE:playerId"
 */
const _reclaimQueue = new Map();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the canonical map key.
 * @param {string} roomCode
 * @param {string} playerId
 * @returns {string}
 */
function _key(roomCode, playerId) {
  return `${roomCode.toUpperCase()}:${playerId}`;
}

// ---------------------------------------------------------------------------
// Disconnect grace timers
// ---------------------------------------------------------------------------

/**
 * Start (or reset) the 60-second grace timer for a disconnected player.
 *
 * If a timer is already running for this player, it is cancelled and replaced
 * so that reconnect-then-disconnect cycles restart the full grace window.
 *
 * @param {string} roomCode
 * @param {string} playerId
 * @param {Function} onExpire - Called when the grace period expires with no reconnect.
 * @param {number} [delayMs] - Grace period in ms (default DISCONNECT_GRACE_MS = 60s).
 */
function startDisconnectTimer(roomCode, playerId, onExpire, delayMs = DISCONNECT_GRACE_MS) {
  const k = _key(roomCode, playerId);

  // Cancel any existing timer before setting a new one.
  const existing = _disconnectTimers.get(k);
  if (existing) clearTimeout(existing);

  const handle = setTimeout(() => {
    _disconnectTimers.delete(k);
    onExpire();
  }, delayMs);

  _disconnectTimers.set(k, handle);
}

/**
 * Cancel a pending disconnect grace timer.
 * Called when the player reconnects within the grace window.
 *
 * @param {string} roomCode
 * @param {string} playerId
 * @returns {boolean} `true` if a running timer was cancelled; `false` if none existed.
 */
function cancelDisconnectTimer(roomCode, playerId) {
  const k = _key(roomCode, playerId);
  const handle = _disconnectTimers.get(k);
  if (!handle) return false;
  clearTimeout(handle);
  _disconnectTimers.delete(k);
  return true;
}

/**
 * Check whether a disconnect grace timer is currently running for a player.
 *
 * @param {string} roomCode
 * @param {string} playerId
 * @returns {boolean}
 */
function hasDisconnectTimer(roomCode, playerId) {
  return _disconnectTimers.has(_key(roomCode, playerId));
}

// ---------------------------------------------------------------------------
// Seat reclaim queue
// ---------------------------------------------------------------------------

/**
 * Add a player to the reclaim queue.
 *
 * Called when the original human player reconnects after their 60s grace
 * expired and a bot has permanently taken over their seat. They will regain
 * control at the next turn boundary when `scheduleBotTurnIfNeeded` detects
 * them in this queue.
 *
 * @param {string} roomCode
 * @param {string} playerId
 */
function addToReclaimQueue(roomCode, playerId) {
  _reclaimQueue.set(_key(roomCode, playerId), { since: Date.now() });
}

/**
 * Remove a player from the reclaim queue (called after successful reclaim).
 *
 * @param {string} roomCode
 * @param {string} playerId
 */
function removeFromReclaimQueue(roomCode, playerId) {
  _reclaimQueue.delete(_key(roomCode, playerId));
}

/**
 * Check whether a player has a pending seat reclaim request.
 *
 * @param {string} roomCode
 * @param {string} playerId
 * @returns {boolean}
 */
function isInReclaimQueue(roomCode, playerId) {
  return _reclaimQueue.has(_key(roomCode, playerId));
}

// ---------------------------------------------------------------------------
// Room cleanup
// ---------------------------------------------------------------------------

/**
 * Cancel all pending timers and reclaim entries for a given room.
 * Called when the game ends to prevent dangling timers.
 *
 * @param {string} roomCode
 */
function clearRoom(roomCode) {
  const prefix = `${roomCode.toUpperCase()}:`;

  for (const [k, handle] of _disconnectTimers.entries()) {
    if (k.startsWith(prefix)) {
      clearTimeout(handle);
      _disconnectTimers.delete(k);
    }
  }

  for (const k of _reclaimQueue.keys()) {
    if (k.startsWith(prefix)) {
      _reclaimQueue.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Reset all state — used in unit tests only.
 */
function _clearAll() {
  for (const handle of _disconnectTimers.values()) {
    clearTimeout(handle);
  }
  _disconnectTimers.clear();
  _reclaimQueue.clear();
}

module.exports = {
  DISCONNECT_GRACE_MS,
  startDisconnectTimer,
  cancelDisconnectTimer,
  hasDisconnectTimer,
  addToReclaimQueue,
  removeFromReclaimQueue,
  isInReclaimQueue,
  clearRoom,
  _clearAll,
};
