'use strict';

/**
 * Per-room player blocklist.
 *
 * Maintains an in-memory Map of roomCode → Set<playerId>.
 *
 * Player identifiers used as keys:
 *   Registered users  → user.id   (UUID from Supabase auth)
 *   Guest sessions    → user.sessionId (UUID from guestSessionStore)
 *
 * The blocklist is checked whenever a player attempts to join a room.
 * Once a player is kicked they remain on the blocklist for the lifetime of
 * the room (no unblock in MVP).  When a room terminates its entry is cleared
 * via clearRoom() to prevent unbounded memory growth.
 *
 * All roomCode lookups are normalised to UPPERCASE so callers can pass the
 * code in any case without worrying about mismatches.
 */

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------

/** @type {Map<string, Set<string>>} roomCode (uppercase) → Set of blocked playerIds */
const _blocklist = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add a player identifier to the blocklist for a given room.
 *
 * Idempotent — calling blockPlayer() for a player who is already blocked is a
 * no-op (the Set silently ignores duplicates).
 *
 * @param {string} roomCode  - The 6-character room code (stored normalised to uppercase)
 * @param {string} playerId  - Stable player identifier (user UUID or guest sessionId)
 * @throws {Error} if either argument is not a non-empty string
 */
function blockPlayer(roomCode, playerId) {
  if (typeof roomCode !== 'string' || roomCode.trim().length === 0) {
    throw new Error('roomCode must be a non-empty string');
  }
  if (typeof playerId !== 'string' || playerId.trim().length === 0) {
    throw new Error('playerId must be a non-empty string');
  }

  const key = roomCode.toUpperCase();

  if (!_blocklist.has(key)) {
    _blocklist.set(key, new Set());
  }
  _blocklist.get(key).add(playerId);
}

/**
 * Check whether a player is on the blocklist for a given room.
 *
 * Returns `false` (not blocked) for any invalid / missing argument rather
 * than throwing, so callers can safely use it as a guard in route handlers.
 *
 * @param {string} roomCode
 * @param {string} playerId
 * @returns {boolean}
 */
function isBlocked(roomCode, playerId) {
  if (typeof roomCode !== 'string' || typeof playerId !== 'string') return false;
  if (roomCode.trim().length === 0 || playerId.trim().length === 0) return false;

  const blockedSet = _blocklist.get(roomCode.toUpperCase());
  if (!blockedSet) return false;
  return blockedSet.has(playerId);
}

/**
 * Return a snapshot array of all player IDs blocked from a room.
 *
 * Returns an empty array when no players have been blocked from that room.
 *
 * @param {string} roomCode
 * @returns {string[]}
 */
function getBlockedPlayers(roomCode) {
  if (typeof roomCode !== 'string' || roomCode.trim().length === 0) return [];
  const blockedSet = _blocklist.get(roomCode.toUpperCase());
  return blockedSet ? Array.from(blockedSet) : [];
}

/**
 * Remove all blocklist entries for a room.
 *
 * Call this when a room reaches a terminal state (completed / cancelled) so
 * the Map entry is GC-eligible and does not grow without bound over time.
 *
 * @param {string} roomCode
 */
function clearRoom(roomCode) {
  if (typeof roomCode !== 'string' || roomCode.trim().length === 0) return;
  _blocklist.delete(roomCode.toUpperCase());
}

/**
 * Return the number of rooms that currently have at least one blocked player.
 * Useful for health-check / metrics endpoints.
 *
 * @returns {number}
 */
function getBlockedRoomCount() {
  return _blocklist.size;
}

// ---------------------------------------------------------------------------
// Helper: derive a stable player identifier from a resolved req.user object
// ---------------------------------------------------------------------------

/**
 * Return the stable player identifier that should be used as a blocklist key.
 *
 * For registered users this is `user.id` (the Supabase UUID).
 * For guests this is `user.sessionId` (the UUID assigned by guestSessionStore).
 *
 * @param {Object} user - The req.user object populated by auth middleware
 * @returns {string|null} - null when user is null/undefined or lacks an identifier
 */
function getPlayerIdentifier(user) {
  if (!user) return null;
  if (user.isGuest) {
    return user.sessionId || null;
  }
  return user.id || null;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Wipe the entire blocklist.
 * ONLY for use in unit/integration tests — never call in production code.
 */
function _resetForTests() {
  _blocklist.clear();
}

/**
 * Expose the raw internal Map.
 * ONLY for use in unit tests to make low-level assertions.
 */
function _getRawBlocklist() {
  return _blocklist;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Core operations
  blockPlayer,
  isBlocked,
  getBlockedPlayers,
  clearRoom,

  // Metrics
  getBlockedRoomCount,

  // Auth helper
  getPlayerIdentifier,

  // Test helpers
  _resetForTests,
  _getRawBlocklist,
};
