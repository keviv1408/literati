'use strict';

/**
 * In-memory game state store.
 *
 * Stores all active GameState objects keyed by roomCode.
 * Also tracks which WebSocket connections belong to each game
 * so the game server can send targeted and broadcast messages.
 *
 * Connection registry: Map<roomCode, Map<playerId, WebSocket>>
 */

/** @type {Map<string, Object>} roomCode → GameState */
const _games = new Map();

/** @type {Map<string, Map<string, import('ws').WebSocket>>} roomCode → playerId → ws */
const _connections = new Map();

// ---------------------------------------------------------------------------
// Game state CRUD
// ---------------------------------------------------------------------------

/**
 * Store a new game state.
 * @param {string} roomCode
 * @param {Object} gameState
 */
function setGame(roomCode, gameState) {
  _games.set(roomCode.toUpperCase(), gameState);
}

/**
 * Retrieve a game state by room code.
 * @param {string} roomCode
 * @returns {Object|undefined}
 */
function getGame(roomCode) {
  return _games.get(roomCode.toUpperCase());
}

/**
 * Delete a game state (called when game ends and is fully cleaned up).
 * @param {string} roomCode
 */
function deleteGame(roomCode) {
  _games.delete(roomCode.toUpperCase());
}

/**
 * Check whether an active game exists for a room.
 * @param {string} roomCode
 * @returns {boolean}
 */
function hasGame(roomCode) {
  return _games.has(roomCode.toUpperCase());
}

// ---------------------------------------------------------------------------
// Connection registry
// ---------------------------------------------------------------------------

/**
 * Register a player's WebSocket connection for a game.
 * @param {string} roomCode
 * @param {string} playerId
 * @param {import('ws').WebSocket} ws
 */
function registerConnection(roomCode, playerId, ws) {
  const code = roomCode.toUpperCase();
  if (!_connections.has(code)) {
    _connections.set(code, new Map());
  }
  _connections.get(code).set(playerId, ws);
}

/**
 * Remove a player's connection.
 * @param {string} roomCode
 * @param {string} playerId
 */
function removeConnection(roomCode, playerId) {
  const code = roomCode.toUpperCase();
  const room = _connections.get(code);
  if (room) {
    room.delete(playerId);
    if (room.size === 0) _connections.delete(code);
  }
}

/**
 * Get the WebSocket for a specific player in a room.
 * @param {string} roomCode
 * @param {string} playerId
 * @returns {import('ws').WebSocket|undefined}
 */
function getConnection(roomCode, playerId) {
  return _connections.get(roomCode.toUpperCase())?.get(playerId);
}

/**
 * Get all WebSocket connections for a room.
 * @param {string} roomCode
 * @returns {Map<string, import('ws').WebSocket>}
 */
function getRoomConnections(roomCode) {
  return _connections.get(roomCode.toUpperCase()) ?? new Map();
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function _clearAll() {
  _games.clear();
  _connections.clear();
}

module.exports = {
  setGame,
  getGame,
  deleteGame,
  hasGame,
  registerConnection,
  removeConnection,
  getConnection,
  getRoomConnections,
  _clearAll,
};
