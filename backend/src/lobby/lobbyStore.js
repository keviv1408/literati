'use strict';

/**
 * In-memory lobby store.
 *
 * Tracks which players are connected to which room lobby (pre-game waiting
 * room). Players are added when they send a 'join-room' WebSocket message and
 * are removed when they:
 * - Disconnect (WebSocket close event)
 * - Are kicked by the host
 * - The game starts
 *
 * Shape of a stored lobby:
 * {
 * roomCode: string — uppercase 6-char room code
 * hostId : string — playerId of the host (registered userId or guest sessionId)
 * players : Map<playerId, LobbyPlayer>
 * }
 *
 * Shape of a LobbyPlayer:
 * {
 * connectionId: string — UUIDv4 unique to this WebSocket connection
 * playerId : string — registered userId or guest sessionId
 * displayName : string
 * avatarId : string | null
 * isGuest : boolean
 * ws : WebSocket — the live socket object
 * }
 */

// ---------------------------------------------------------------------------
// Internal stores
// ---------------------------------------------------------------------------

/** @type {Map<string, LobbyRoom>} roomCode → LobbyRoom */
const _rooms = new Map();

/**
 * Reverse index: connectionId → { roomCode, playerId }
 * Allows O(1) cleanup when a socket closes.
 *
 * @type {Map<string, { roomCode: string, playerId: string }>}
 */
const _connectionIndex = new Map();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get an existing lobby, or create one if it does not exist yet.
 *
 * Called when the first player (the host) joins the WebSocket for a room.
 *
 * @param {string} roomCode - Uppercase 6-char room code.
 * @param {string} hostId - playerId of the room host.
 * @returns {LobbyRoom}
 */
function getOrCreateLobby(roomCode, hostId) {
  if (!_rooms.has(roomCode)) {
    _rooms.set(roomCode, {
      roomCode,
      hostId,
      players: new Map(),
    });
  }
  return _rooms.get(roomCode);
}

/**
 * Return the lobby for a room, or null if it does not exist.
 *
 * @param {string} roomCode
 * @returns {LobbyRoom|null}
 */
function getLobby(roomCode) {
  return _rooms.get(roomCode) || null;
}

/**
 * Add a player to an existing lobby.
 *
 * @param {string} roomCode
 * @param {LobbyPlayer} player
 * @returns {boolean} false if the lobby does not exist
 */
function addPlayerToLobby(roomCode, player) {
  const lobby = _rooms.get(roomCode);
  if (!lobby) return false;

  lobby.players.set(player.playerId, player);
  _connectionIndex.set(player.connectionId, {
    roomCode,
    playerId: player.playerId,
  });
  return true;
}

/**
 * Remove a player from a lobby by their playerId.
 *
 * Also removes the corresponding connection-index entry.
 * Deletes the lobby itself if it becomes empty after removal.
 *
 * @param {string} roomCode
 * @param {string} playerId
 * @returns {LobbyPlayer|null} the removed player object, or null if not found
 */
function removePlayerFromLobby(roomCode, playerId) {
  const lobby = _rooms.get(roomCode);
  if (!lobby) return null;

  const player = lobby.players.get(playerId);
  if (!player) return null;

  lobby.players.delete(playerId);
  _connectionIndex.delete(player.connectionId);

  // Prune empty lobbies to avoid memory leaks.
  if (lobby.players.size === 0) {
    _rooms.delete(roomCode);
  }

  return player;
}

/**
 * Remove a player from their current lobby using only their connectionId.
 *
 * Useful in WebSocket `close` event handlers where only the connectionId is
 * readily available.
 *
 * @param {string} connectionId
 * @returns {{ roomCode: string, playerId: string, displayName: string, avatarId: string|null, isGuest: boolean }|null}
 * The removed player augmented with the room code, or null if the connection
 * was not tracked (already removed / never joined a room).
 */
function removeConnectionFromLobby(connectionId) {
  const entry = _connectionIndex.get(connectionId);
  if (!entry) return null;

  const player = removePlayerFromLobby(entry.roomCode, entry.playerId);
  if (!player) return null;

  // Attach roomCode so callers can broadcast without a separate lookup.
  return { ...player, roomCode: entry.roomCode };
}

/**
 * Return all players currently in a lobby as an array.
 *
 * @param {string} roomCode
 * @returns {LobbyPlayer[]}
 */
function getLobbyPlayers(roomCode) {
  const lobby = _rooms.get(roomCode);
  if (!lobby) return [];
  return Array.from(lobby.players.values());
}

// ---------------------------------------------------------------------------
// Test helpers (never import these outside of test files)
// ---------------------------------------------------------------------------

/** Wipe all lobbies and the connection index. */
function _clearAll() {
  _rooms.clear();
  _connectionIndex.clear();
}

/** Direct read of the raw rooms map — for test assertions. */
function _getRooms() {
  return _rooms;
}

/** Direct read of the raw connection index — for test assertions. */
function _getConnectionIndex() {
  return _connectionIndex;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Core CRUD
  getOrCreateLobby,
  getLobby,
  addPlayerToLobby,
  removePlayerFromLobby,
  removeConnectionFromLobby,
  getLobbyPlayers,

  // Test helpers
  _clearAll,
  _getRooms,
  _getConnectionIndex,
};
