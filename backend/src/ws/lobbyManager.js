'use strict';

/**
 * In-memory lobby state manager.
 *
 * Tracks which players are in each room lobby, their seat/team assignments,
 * and their WebSocket connections.
 *
 * This module uses plain Maps for real-time lobby state to avoid per-message
 * DB round-trips. The authoritative room record (status, player_count, variant)
 * lives in Supabase; lobby membership is ephemeral.
 *
 * Seat layout: seats alternate Team 1 / Team 2 clockwise.
 * - even seatIndex (0, 2, 4, ...) → Team 1 (default)
 * - odd seatIndex (1, 3, 5, ...) → Team 2 (default)
 *
 * The host may override individual team assignments via lobby:reassign_team,
 * subject to team-balance validation (no team may exceed playerCount 2).
 */

// ---------------------------------------------------------------------------
// Type definitions (JSDoc)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} LobbySeat
 * @property {number} seatIndex - 0-based position around the table
 * @property {string} playerId - userId (registered) or sessionId (guest)
 * @property {string} displayName - human-readable name
 * @property {string} [avatarId] - optional avatar identifier
 * @property {1|2} teamId - current team assignment
 * @property {boolean} isBot - whether this is a bot player
 * @property {boolean} isGuest - whether this is a guest player
 */

/**
 * @typedef {Object} LobbyRoom
 * @property {string} roomId - UUID from Supabase
 * @property {string} roomCode - 6-char display code
 * @property {string} hostPlayerId - playerId of the host
 * @property {number} playerCount - 6 or 8
 * @property {string} status - mirrors rooms.status
 * @property {Map<number, LobbySeat>} seats - seatIndex → LobbySeat
 * @property {Map<string, import('ws').WebSocket>} connections - playerId → WebSocket
 */

// ---------------------------------------------------------------------------
// Internal store
// ---------------------------------------------------------------------------

/** @type {Map<string, LobbyRoom>} roomCode (uppercase) → LobbyRoom */
const _rooms = new Map();

// ---------------------------------------------------------------------------
// Room lifecycle
// ---------------------------------------------------------------------------

/**
 * Initialise a new lobby room from Supabase room data.
 * If the room is already tracked, the existing record is returned unchanged.
 *
 * @param {Object} opts
 * @param {string} opts.roomId
 * @param {string} opts.roomCode - must be uppercase
 * @param {string} opts.hostPlayerId
 * @param {number} opts.playerCount - 6 or 8
 * @param {string} [opts.status] - defaults to 'waiting'
 * @returns {LobbyRoom}
 */
function initLobbyRoom({ roomId, roomCode, hostPlayerId, playerCount, status = 'waiting' }) {
  const key = roomCode.toUpperCase();
  if (_rooms.has(key)) return _rooms.get(key);

  const room = {
    roomId,
    roomCode: key,
    hostPlayerId,
    playerCount,
    status,
    seats: new Map(),
    connections: new Map(),
  };

  _rooms.set(key, room);
  return room;
}

/**
 * Retrieve a tracked lobby room by its code.
 *
 * @param {string} roomCode
 * @returns {LobbyRoom|null}
 */
function getLobbyRoom(roomCode) {
  return _rooms.get(roomCode.toUpperCase()) || null;
}

/**
 * Close all connections in a room and remove it from tracking.
 * Called after the game ends, the room is cancelled, or on server shutdown.
 *
 * @param {string} roomCode
 */
function deleteLobbyRoom(roomCode) {
  const key = roomCode.toUpperCase();
  const room = _rooms.get(key);
  if (!room) return;

  for (const ws of room.connections.values()) {
    try { ws.terminate(); } catch (_) { /* already closed */ }
  }
  _rooms.delete(key);
}

// ---------------------------------------------------------------------------
// Seat management
// ---------------------------------------------------------------------------

/**
 * Assign a player to a seat in the lobby.
 * Overwrites any previous occupant at that seat index.
 *
 * @param {string} roomCode
 * @param {LobbySeat} seat
 * @returns {LobbyRoom}
 * @throws {Error} if the room is not tracked
 */
function addPlayerToLobby(roomCode, seat) {
  const room = _getLobbyRoomOrThrow(roomCode);
  room.seats.set(seat.seatIndex, { ...seat });
  return room;
}

/**
 * Remove a player's seat and WebSocket connection from the lobby.
 *
 * @param {string} roomCode
 * @param {string} playerId
 */
function removePlayerFromLobby(roomCode, playerId) {
  const room = getLobbyRoom(roomCode);
  if (!room) return;

  room.connections.delete(playerId);

  for (const [idx, seat] of room.seats.entries()) {
    if (seat.playerId === playerId) {
      room.seats.delete(idx);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Connection management
// ---------------------------------------------------------------------------

/**
 * Register (or replace) the WebSocket connection for a player in a room.
 *
 * @param {string} roomCode
 * @param {string} playerId
 * @param {import('ws').WebSocket} ws
 */
function setPlayerConnection(roomCode, playerId, ws) {
  const room = getLobbyRoom(roomCode);
  if (!room) return;
  room.connections.set(playerId, ws);
}

/**
 * Unregister a player's WebSocket without removing their seat.
 * The player is still "in the lobby" but disconnected.
 *
 * @param {string} roomCode
 * @param {string} playerId
 */
function removePlayerConnection(roomCode, playerId) {
  const room = getLobbyRoom(roomCode);
  if (!room) return;
  room.connections.delete(playerId);
}

// ---------------------------------------------------------------------------
// Team reassignment (core logic for )
// ---------------------------------------------------------------------------

/**
 * Reassign a single player to a new team, subject to balance validation.
 *
 * Balance rule: after the change, no team may have more than
 * `Math.floor(playerCount 2)` members. This prevents the host from
 * creating an unbalanced split in a full lobby (e.g. 4 vs 2 in a 6-player
 * room), while still allowing flexible assignments in partially-filled lobbies.
 *
 * Edge cases:
 * - Player already on newTeamId → treated as a no-op success.
 * - Player not found in room → error.
 * - Full balanced lobby → any single move would exceed the per-team
 * cap, so the operation is rejected (a swap via two sequential calls is
 * needed once an imbalance is temporarily permitted in a partial lobby).
 *
 * @param {string} roomCode
 * @param {string} targetPlayerId
 * @param {1|2} newTeamId
 * @returns {{ success: true, seats: LobbySeat[] } |
 * { success: false, error: string }}
 */
function reassignPlayerTeam(roomCode, targetPlayerId, newTeamId) {
  const room = _rooms.get(roomCode.toUpperCase());
  if (!room) {
    return { success: false, error: 'Room not found in lobby' };
  }

  // --- validate newTeamId ---
  if (newTeamId !== 1 && newTeamId !== 2) {
    return { success: false, error: 'newTeamId must be 1 or 2' };
  }

  // --- locate player ---
  const targetSeat = _findSeatByPlayerId(room, targetPlayerId);
  if (!targetSeat) {
    return { success: false, error: 'Player not found in room' };
  }

  // --- no-op when team is unchanged ---
  if (targetSeat.teamId === newTeamId) {
    return { success: true, seats: _seatsArray(room) };
  }

  // --- team-balance validation ---
  const maxPerTeam = Math.floor(room.playerCount / 2);

  // Count teams after the hypothetical move.
  let newTeamCount = 0;
  for (const seat of room.seats.values()) {
    const effectiveTeam = seat.playerId === targetPlayerId ? newTeamId : seat.teamId;
    if (effectiveTeam === newTeamId) newTeamCount++;
  }

  if (newTeamCount > maxPerTeam) {
    return {
      success: false,
      error:
        `Team ${newTeamId} would have ${newTeamCount} players, ` +
        `exceeding the maximum of ${maxPerTeam} for a ${room.playerCount}-player game`,
    };
  }

  // --- apply ---
  targetSeat.teamId = newTeamId;

  return { success: true, seats: _seatsArray(room) };
}

// ---------------------------------------------------------------------------
// Snapshot & broadcast helpers
// ---------------------------------------------------------------------------

/**
 * Return a plain-object snapshot of the lobby (safe to JSON-serialise).
 * WebSocket objects are excluded.
 *
 * @param {string} roomCode
 * @returns {Object|null}
 */
function getLobbySnapshot(roomCode) {
  const room = _rooms.get(roomCode.toUpperCase());
  if (!room) return null;

  return {
    roomId: room.roomId,
    roomCode: room.roomCode,
    hostPlayerId: room.hostPlayerId,
    playerCount: room.playerCount,
    status: room.status,
    seats: _seatsArray(room),
    connectedPlayerIds: Array.from(room.connections.keys()),
  };
}

/**
 * Broadcast a JSON message to all currently-connected players in a room.
 *
 * @param {string} roomCode
 * @param {object} message - will be JSON-stringified
 */
function broadcastToRoom(roomCode, message) {
  const room = _rooms.get(roomCode.toUpperCase());
  if (!room) return;

  const payload = JSON.stringify(message);

  for (const ws of room.connections.values()) {
    // 1 === WebSocket.OPEN
    if (ws.readyState === 1) {
      try { ws.send(payload); } catch (_) { /* connection dropped mid-send */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * @param {string} roomCode
 * @returns {LobbyRoom}
 * @throws {Error}
 */
function _getLobbyRoomOrThrow(roomCode) {
  const room = _rooms.get(roomCode.toUpperCase());
  if (!room) throw new Error(`Lobby room not found: ${roomCode}`);
  return room;
}

/**
 * Find the LobbySeat for a playerId within a room.
 *
 * @param {LobbyRoom} room
 * @param {string} playerId
 * @returns {LobbySeat|null}
 */
function _findSeatByPlayerId(room, playerId) {
  for (const seat of room.seats.values()) {
    if (seat.playerId === playerId) return seat;
  }
  return null;
}

/** Convert the seats Map to a sorted array (ascending seatIndex). */
function _seatsArray(room) {
  return Array.from(room.seats.values()).sort((a, b) => a.seatIndex - b.seatIndex);
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Wipe all tracked rooms. Used in tests to reset state between cases. */
function _clearRooms() {
  _rooms.clear();
}

/** Direct read of the raw store. Used in tests to inspect internal state. */
function _getRawRooms() {
  return _rooms;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Room lifecycle
  initLobbyRoom,
  getLobbyRoom,
  deleteLobbyRoom,

  // Seat management
  addPlayerToLobby,
  removePlayerFromLobby,

  // Connection management
  setPlayerConnection,
  removePlayerConnection,

  // Team reassignment
  reassignPlayerTeam,

  // Snapshot & broadcast
  getLobbySnapshot,
  broadcastToRoom,

  // Test helpers
  _clearRooms,
  _getRawRooms,
};
