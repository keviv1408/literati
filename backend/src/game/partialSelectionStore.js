'use strict';

/**
 * Partial selection store for in-progress ask/declare flows.
 *
 * When a human player is mid-flow (e.g. chose a half-suit but hasn't yet
 * picked a card or opponent), the client sends `partial_selection` messages
 * here so the server can complete the action deterministically if the
 * turn timer fires before the player finishes.
 *
 * Key:   `${ROOMCODE}:${playerId}`
 * Value: PartialSelection object
 *
 * Partial selection shapes:
 *   Ask flow (step 2 entered — half-suit chosen):
 *     { flow: 'ask', halfSuitId: string }
 *
 *   Ask flow (step 3 entered — card also chosen):
 *     { flow: 'ask', halfSuitId: string, cardId: string }
 *
 *   Declare flow (suit chosen, with current assignment state):
 *     { flow: 'declare', halfSuitId: string, assignment: Record<string,string> }
 */

/** @type {Map<string, Object>} key → partial selection */
const _store = new Map();

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the composite store key.
 * @param {string} roomCode
 * @param {string} playerId
 * @returns {string}
 */
function _key(roomCode, playerId) {
  return `${roomCode.toUpperCase()}:${playerId}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Store or update a partial selection for a player.
 *
 * @param {string} roomCode
 * @param {string} playerId
 * @param {Object} partial  - PartialSelection object (see shapes above)
 */
function setPartialSelection(roomCode, playerId, partial) {
  _store.set(_key(roomCode, playerId), partial);
}

/**
 * Retrieve the partial selection for a player.
 *
 * @param {string} roomCode
 * @param {string} playerId
 * @returns {Object|null}  - PartialSelection or null if none stored
 */
function getPartialSelection(roomCode, playerId) {
  return _store.get(_key(roomCode, playerId)) ?? null;
}

/**
 * Clear the partial selection for a specific player.
 * Call this when:
 *   • the player submits a valid ask or declare
 *   • the turn passes to another player
 *
 * @param {string} roomCode
 * @param {string} playerId
 */
function clearPartialSelection(roomCode, playerId) {
  _store.delete(_key(roomCode, playerId));
}

/**
 * Clear ALL partial selections for an entire room.
 * Call this when the game ends or is abandoned.
 *
 * @param {string} roomCode
 */
function clearRoomPartialSelections(roomCode) {
  const prefix = `${roomCode.toUpperCase()}:`;
  for (const key of _store.keys()) {
    if (key.startsWith(prefix)) {
      _store.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/**
 * Clear ALL entries (used in unit tests only).
 */
function _clearAll() {
  _store.clear();
}

module.exports = {
  setPartialSelection,
  getPartialSelection,
  clearPartialSelection,
  clearRoomPartialSelections,
  _clearAll,
  // Exposed for external test inspection only — do NOT mutate from outside this module:
  _partialSelections: _store,
};
