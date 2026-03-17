'use strict';

/**
 * Pending rematch store — persists cloned room settings from a completed game
 * that has been voted for a rematch.
 *
 * After a majority of players vote yes for a rematch the server snapshots the
 * finished game's configuration (player team assignments, card-removal variant,
 * and playerCount) so the next game can be started with
 * identical settings.  The snapshot is stored keyed by roomCode and is read
 * by:
 *
 *   1. The `rematch_start` broadcast — includes previousTeams + config so
 *      clients can immediately show the correct lobby state.
 *   2. roomSocketServer — when players reconnect to the room lobby after a
 *      rematch, their previous teamId is looked up here and restored.
 *   3. POST /api/rooms/:code/start (routes/rooms.js) — bot seats from the
 *      previous game are re-used in place of freshly generated ones so the
 *      same bots appear again (same display names etc.).
 *
 * Lifecycle:
 *   setPendingRematch(code, settings)   — called by handleRematchVote
 *   getPendingRematch(code)             — read by consumers above
 *   clearPendingRematch(code)           — called after the next game starts
 *
 * @module pendingRematchStore
 */

/**
 * @typedef {Object} PendingPlayerSettings
 * @property {string}      playerId
 * @property {string}      displayName
 * @property {string|null} avatarId
 * @property {1|2}         teamId
 * @property {number}      seatIndex
 * @property {boolean}     isBot
 * @property {boolean}     isGuest
 */

/**
 * @typedef {Object} PendingRematch
 * @property {PendingPlayerSettings[]} players       — full player roster from the finished game
 * @property {string}                  variant       — card-removal variant ('remove_2s'|…)
 * @property {number}                  playerCount   — 6 or 8
 * @property {number}                  createdAt     — epoch ms when the snapshot was taken
 */

/** @type {Map<string, PendingRematch>} roomCode (uppercase) → PendingRematch */
const _pending = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store the pending rematch settings for a room.
 *
 * Overwrites any previously stored snapshot for the room (e.g. if a rematch
 * vote somehow fires twice before the lobby is revisited).
 *
 * @param {string}       roomCode
 * @param {PendingRematch} settings
 */
function setPendingRematch(roomCode, settings) {
  _pending.set(roomCode.toUpperCase(), {
    ...settings,
    createdAt: Date.now(),
  });
}

/**
 * Retrieve the pending rematch settings for a room.
 *
 * @param {string} roomCode
 * @returns {PendingRematch|null}
 */
function getPendingRematch(roomCode) {
  return _pending.get(roomCode.toUpperCase()) ?? null;
}

/**
 * Check whether a pending rematch snapshot exists for a room.
 *
 * @param {string} roomCode
 * @returns {boolean}
 */
function hasPendingRematch(roomCode) {
  return _pending.has(roomCode.toUpperCase());
}

/**
 * Remove the pending rematch settings for a room.
 * Call this after the next game has been created so stale snapshots don't
 * bleed into future rounds.
 *
 * @param {string} roomCode
 */
function clearPendingRematch(roomCode) {
  _pending.delete(roomCode.toUpperCase());
}

// ---------------------------------------------------------------------------
// Test helper — resets all state between tests
// ---------------------------------------------------------------------------

/** @internal */
function _clearAll() {
  _pending.clear();
}

module.exports = {
  setPendingRematch,
  getPendingRematch,
  hasPendingRematch,
  clearPendingRematch,
  _clearAll,
};
