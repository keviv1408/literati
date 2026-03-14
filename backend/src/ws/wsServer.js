'use strict';

/**
 * WebSocket server for Literati.
 *
 * Lifecycle:
 *   1. Client opens ws://host/ws?token=<bearer_token>
 *   2. Server authenticates token → resolves { playerId, displayName, ... }
 *   3. Client sends 'join-room' → added to in-memory lobby
 *   4. Host sends 'kick-player' → target removed + broadcast 'player-kicked'
 *   5. Disconnect → player removed + broadcast 'player-left'
 *
 * Lobby fill timer (Sub-AC 8c):
 *   When the first human player joins a room lobby a 2-minute countdown starts.
 *   If the lobby reaches capacity before the timer fires, the timer is cancelled
 *   and the game starts immediately.  If the timer fires first, any remaining
 *   open seats are filled with bot players and the game starts.
 *
 * Message schema (all JSON):
 *
 *   Client → Server
 *   ───────────────
 *   { type: 'join-room',     roomCode: string }
 *   { type: 'kick-player',   roomCode: string, targetPlayerId: string }
 *   { type: 'reassign-team', roomCode: string, targetPlayerId: string, newTeamId: 1|2 }
 *
 *   Server → Client (targeted)
 *   ───────────────────────────
 *   { type: 'connected',          playerId, displayName }
 *   { type: 'room-joined',        roomCode, playerId, players: [...] }
 *   { type: 'kick-confirmed',     roomCode, playerId }
 *   { type: 'you-were-kicked',    roomCode }
 *   { type: 'error',              message, code? }
 *
 *   Server → Room (broadcast)
 *   ─────────────────────────
 *   { type: 'player-joined',      roomCode, player: { playerId, displayName, avatarId, isGuest } }
 *   { type: 'player-kicked',      roomCode, playerId, displayName }
 *   { type: 'player-left',        roomCode, playerId, displayName }
 *   { type: 'lobby-timer-started',roomCode, expiresAt }
 *   { type: 'lobby-starting',     roomCode, seats, botsAdded: string[] }
 */

const { WebSocketServer, WebSocket } = require('ws');
const url = require('url');
const { v4: uuidv4 } = require('uuid');

const { getGuestSession } = require('../sessions/guestSessionStore');
const { getSupabaseClient } = require('../db/supabase');
const {
  getOrCreateLobby,
  getLobby,
  addPlayerToLobby,
  removePlayerFromLobby,
  removeConnectionFromLobby,
  getLobbyPlayers,
} = require('../lobby/lobbyStore');
const { blockPlayer } = require('../rooms/roomBlocklist');
const lobbyManager = require('./lobbyManager');
const { startLobbyTimer, cancelLobbyTimer, isLobbyTimerActive } = require('../matchmaking/lobbyTimer');
const { fillWithBots } = require('../matchmaking/botFiller');
const {
  handleJoinQueue,
  handleLeaveQueue,
  cleanupQueuedPlayer,
} = require('../matchmaking/matchmakingManager');

// Game engine — loaded lazily to avoid circular deps at startup
let _gameSocketServer = null;
function _getGameServer() {
  if (!_gameSocketServer) {
    _gameSocketServer = require('../game/gameSocketServer');
  }
  return _gameSocketServer;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an opaque bearer token to a minimal user identity object.
 *
 * Resolution order mirrors auth.js:
 *   1. In-memory guest session store (no DB round-trip)
 *   2. Supabase JWT verification
 *
 * @param {string|null|undefined} token
 * @returns {Promise<{ playerId: string, displayName: string, avatarId: string|null, isGuest: boolean }|null>}
 */
async function resolveTokenToUser(token) {
  if (!token || typeof token !== 'string' || token.length === 0) return null;

  // 1. Guest session (fast in-memory lookup)
  const guestSession = getGuestSession(token);
  if (guestSession) {
    return {
      playerId: guestSession.sessionId,
      displayName: guestSession.displayName,
      avatarId: guestSession.avatarId,
      isGuest: true,
    };
  }

  // 2. Supabase JWT
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;

    const { user } = data;
    return {
      playerId: user.id,
      displayName: user.user_metadata?.display_name || user.email,
      avatarId: user.user_metadata?.avatar_id || null,
      isGuest: false,
    };
  } catch {
    return null;
  }
}

/**
 * Send a JSON payload to a single WebSocket, suppressing errors when the
 * socket is no longer open.
 *
 * @param {WebSocket} ws
 * @param {object} data
 */
function sendJson(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/**
 * Broadcast a JSON payload to every player currently in a room.
 *
 * @param {string} roomCode
 * @param {object} data
 * @param {string} [excludeConnectionId] - Skip this connection (e.g. the sender).
 */
function broadcastToRoom(roomCode, data, excludeConnectionId) {
  const players = getLobbyPlayers(roomCode);
  for (const player of players) {
    if (excludeConnectionId && player.connectionId === excludeConnectionId) {
      continue;
    }
    sendJson(player.ws, data);
  }
}

// ---------------------------------------------------------------------------
// Game-start helpers (Sub-AC 8c)
// ---------------------------------------------------------------------------

/**
 * Compute the next available seat index for a new player joining a room.
 *
 * Scans 0 … playerCount-1 for the first index not already in the seats Map.
 *
 * @param {Map<number, Object>} seats      - Current lobbyManager seats.
 * @param {number}              playerCount
 * @returns {number} Next available 0-based seat index, or -1 if the room is full.
 */
function _nextAvailableSeat(seats, playerCount) {
  for (let i = 0; i < playerCount; i++) {
    if (!seats.has(i)) return i;
  }
  return -1;
}

/**
 * Trigger the game start sequence.
 *
 * Steps:
 *   1. Cancel any pending lobby fill timer (safe to call even if already fired).
 *   2. Retrieve the current seats from lobbyManager.
 *   3. Generate bot players for every empty seat.
 *   4. Add the bots to lobbyManager (so the full seat map is consistent).
 *   5. Update the room status in Supabase to 'starting'.
 *   6. Broadcast 'lobby-starting' to all connected human players.
 *
 * This function is safe to call multiple times for the same room; subsequent
 * calls are no-ops once the status transitions away from 'waiting'.
 *
 * @param {string} roomCode   - Uppercase 6-char room code.
 * @param {number} playerCount - Total seats (6 or 8).
 * @returns {Promise<void>}
 */
async function _handleGameStart(roomCode, playerCount) {
  // Cancel any pending timer (idempotent).
  cancelLobbyTimer(roomCode);

  const lobbyRoom = lobbyManager.getLobbyRoom(roomCode);

  // Determine the occupied seat map (may be null if no lobbyManager init happened).
  const seats = lobbyRoom ? lobbyRoom.seats : new Map();

  // Fill empty seats with bots.
  const bots = fillWithBots(playerCount, seats);
  for (const bot of bots) {
    if (lobbyRoom) {
      lobbyManager.addPlayerToLobby(roomCode, bot);
    }
  }

  // Build the final seat snapshot (sorted by seatIndex).
  const snapshotSeats = lobbyRoom
    ? Array.from(lobbyRoom.seats.values()).sort((a, b) => a.seatIndex - b.seatIndex)
    : bots;

  // Fetch room metadata (id and variant) for game creation.
  let roomId   = null;
  let variant  = 'remove_7s';
  try {
    const supabase = getSupabaseClient();
    const { data: roomData } = await supabase
      .from('rooms')
      .select('id, card_removal_variant')
      .eq('code', roomCode)
      .maybeSingle();

    if (roomData) {
      roomId  = roomData.id;
      variant = roomData.card_removal_variant || 'remove_7s';
    }
  } catch (err) {
    console.error('[game-start] Failed to fetch room metadata for', roomCode, ':', err);
  }

  // ── Create the game state ──────────────────────────────────────────────────
  let gameState = null;
  try {
    const gameServer = _getGameServer();
    gameState = gameServer.createGame({
      roomCode,
      roomId:      roomId ?? roomCode, // fallback if DB fetch failed
      variant,
      playerCount,
      seats:       snapshotSeats,
    });
  } catch (err) {
    console.error('[game-start] Failed to create game state for room', roomCode, ':', err);
  }

  // ── Update Supabase room status to 'starting' then 'in_progress' ─────────
  // First set to 'starting' so clients redirect to the game page.
  // Then set to 'in_progress' with the initial game_state snapshot.
  try {
    const supabase = getSupabaseClient();
    await supabase
      .from('rooms')
      .update({ status: 'starting' })
      .eq('code', roomCode);
  } catch (err) {
    console.error('[game-start] Supabase status update (starting) failed for room', roomCode, ':', err);
  }

  // Persist game state (sets status to in_progress) — done async after broadcast
  if (gameState) {
    process.nextTick(async () => {
      try {
        const { persistGameState } = require('../game/gameState');
        const supabase = getSupabaseClient();
        await persistGameState(gameState, supabase);
      } catch (err) {
        console.error('[game-start] Failed to persist initial game state:', err);
      }
    });
  }

  // ── Broadcast to all connected human players ───────────────────────────────
  broadcastToRoom(roomCode, {
    type:      'lobby-starting',
    roomCode,
    seats:     snapshotSeats,
    botsAdded: bots.map((b) => b.playerId),
  });

  // If the first turn belongs to a bot, schedule its turn (will fire once
  // clients connect to /ws/game/<CODE>).
  if (gameState && gameState.status === 'active') {
    const firstPlayer = gameState.players.find(
      (p) => p.playerId === gameState.currentTurnPlayerId
    );
    if (firstPlayer && firstPlayer.isBot) {
      // Delay slightly more than the client redirect time
      setTimeout(() => {
        const gameServer = _getGameServer();
        gameServer.scheduleBotTurnIfNeeded(gameState);
      }, 3000);
    }
  }
}

/**
 * Handler invoked when the lobby fill timer fires.
 *
 * Fetches the room from Supabase to confirm it is still in 'waiting' status
 * before triggering the game start.  Guards against races where the room
 * was cancelled or already started between the timer being set and firing.
 *
 * @param {string} roomCode - Uppercase room code (passed by lobbyTimer).
 * @returns {Promise<void>}
 */
async function _handleTimerExpiry(roomCode) {
  let playerCount;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('rooms')
      .select('player_count, status')
      .eq('code', roomCode)
      .maybeSingle();

    if (error || !data) {
      console.warn('[lobby-timer] Room not found in DB on expiry:', roomCode);
      return;
    }

    if (data.status !== 'waiting') {
      // Room is no longer waiting (already started, cancelled, etc.) — skip.
      return;
    }

    playerCount = data.player_count;
  } catch (err) {
    console.error('[lobby-timer] DB error on timer expiry for room', roomCode, ':', err);
    return;
  }

  await _handleGameStart(roomCode, playerCount);
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

/**
 * Route incoming WebSocket messages to the appropriate handler.
 *
 * @param {WebSocket} ws
 * @param {string} connectionId
 * @param {{ playerId, displayName, avatarId, isGuest }} user
 * @param {Buffer|string} rawData
 */
async function handleMessage(ws, connectionId, user, rawData) {
  let msg;
  try {
    msg = JSON.parse(rawData.toString());
  } catch {
    sendJson(ws, { type: 'error', message: 'Invalid JSON' });
    return;
  }

  if (!msg || typeof msg.type !== 'string') {
    sendJson(ws, { type: 'error', message: 'Message must have a type field' });
    return;
  }

  switch (msg.type) {
    case 'join-room':
      await handleJoinRoom(ws, connectionId, user, msg);
      break;

    case 'kick-player':
      await handleKickPlayer(ws, connectionId, user, msg);
      break;

    case 'reassign-team':
      await handleReassignTeam(ws, connectionId, user, msg);
      break;

    // ── Matchmaking queue messages (Sub-AC 8b) ──────────────────────────────
    case 'join-queue':
      await handleJoinQueue(ws, connectionId, user, msg);
      break;

    case 'leave-queue':
      handleLeaveQueue(ws, connectionId, user);
      break;

    default:
      sendJson(ws, {
        type: 'error',
        message: `Unknown message type: ${msg.type}`,
      });
  }
}

// ---------------------------------------------------------------------------
// join-room handler
// ---------------------------------------------------------------------------

/**
 * Handle a 'join-room' message.
 *
 * Expected payload: { type: 'join-room', roomCode: string }
 *
 * Steps:
 *   1. Validate roomCode format
 *   2. Look up room in DB (must exist and be in 'waiting' status)
 *   3. Add player to in-memory lobby (lobbyStore + lobbyManager)
 *   4. Confirm to the joining player ('room-joined')
 *   5. Notify all other players in the room ('player-joined')
 *   6a. If room is now full → cancel timer and start game immediately.
 *   6b. If this is the first player → start the 2-minute fill timer and
 *       broadcast 'lobby-timer-started' to the room.
 *
 * @param {WebSocket} ws
 * @param {string} connectionId
 * @param {{ playerId, displayName, avatarId, isGuest }} user
 * @param {{ type: string, roomCode: string }} msg
 */
async function handleJoinRoom(ws, connectionId, user, msg) {
  const { roomCode } = msg;

  if (!roomCode || typeof roomCode !== 'string' || roomCode.length !== 6) {
    sendJson(ws, { type: 'error', message: 'Invalid roomCode: must be a 6-character string' });
    return;
  }

  const upperCode = roomCode.toUpperCase();

  // Verify the room exists and is accepting players.
  let room;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('rooms')
      .select('id, code, host_user_id, player_count, card_removal_variant, status')
      .eq('code', upperCode)
      .maybeSingle();

    if (error || !data) {
      sendJson(ws, { type: 'error', message: 'Room not found' });
      return;
    }

    if (data.status !== 'waiting') {
      sendJson(ws, {
        type: 'error',
        code: 'ROOM_NOT_WAITING',
        message: 'Room is not accepting players',
      });
      return;
    }

    room = data;
  } catch {
    sendJson(ws, { type: 'error', message: 'Internal error verifying room' });
    return;
  }

  // ── Ensure both lobby stores know about this room ───────────────────────────

  // Legacy lobbyStore: used by broadcast helpers and kick handler.
  getOrCreateLobby(upperCode, room.host_user_id);

  // lobbyManager: tracks seats + team assignments + WS connections.
  if (!lobbyManager.getLobbyRoom(upperCode)) {
    lobbyManager.initLobbyRoom({
      roomId:       room.id,
      roomCode:     upperCode,
      hostPlayerId: room.host_user_id,
      playerCount:  room.player_count,
      status:       room.status,
    });
  }

  // ── Snapshot existing players BEFORE adding the joiner ─────────────────────
  const existingPlayersBeforeJoin = getLobbyPlayers(upperCode);
  const hostId = room.host_user_id;

  // Detect whether this player is already in the lobby (reconnect).
  const alreadyInLobby = existingPlayersBeforeJoin.some(
    (p) => p.playerId === user.playerId
  );

  /**
   * Build a wire-safe player snapshot that includes the isHost flag.
   * Strips the WebSocket reference and any internal connection metadata.
   */
  function toPlayerSnapshot(p) {
    return {
      playerId:    p.playerId,
      displayName: p.displayName,
      avatarId:    p.avatarId ?? null,
      isGuest:     p.isGuest,
      isHost:      p.playerId === hostId,
    };
  }

  // ── Register this player in the lobby stores ────────────────────────────────

  // lobbyStore (for broadcast + kick)
  addPlayerToLobby(upperCode, {
    connectionId,
    playerId:    user.playerId,
    displayName: user.displayName,
    avatarId:    user.avatarId,
    isGuest:     user.isGuest,
    ws,
  });

  // lobbyManager (for seat/team tracking + timer expiry bot-fill)
  if (!alreadyInLobby) {
    const lobbyRoom = lobbyManager.getLobbyRoom(upperCode);
    const seatIndex = _nextAvailableSeat(lobbyRoom.seats, room.player_count);

    if (seatIndex !== -1) {
      lobbyManager.addPlayerToLobby(upperCode, {
        seatIndex,
        playerId:    user.playerId,
        displayName: user.displayName,
        avatarId:    user.avatarId ?? null,
        teamId:      /** @type {1|2} */ (seatIndex % 2 === 0 ? 1 : 2),
        isBot:       false,
        isGuest:     user.isGuest,
      });
    }
  }

  // Register the live WebSocket connection so lobbyManager.broadcastToRoom
  // and setPlayerConnection work correctly.
  lobbyManager.setPlayerConnection(upperCode, user.playerId, ws);

  // ── Build the full snapshot: everyone who was already here + the new joiner ─
  const allPlayersSnapshot = [
    ...existingPlayersBeforeJoin.map(toPlayerSnapshot),
    toPlayerSnapshot(user),
  ];

  // Confirm join to the new player AND deliver the complete current roster.
  sendJson(ws, {
    type:     'room-joined',
    roomCode: upperCode,
    playerId: user.playerId,
    players:  allPlayersSnapshot,
  });

  // Notify everyone ELSE already in the room about the arrival.
  broadcastToRoom(
    upperCode,
    {
      type:     'player-joined',
      roomCode: upperCode,
      player:   toPlayerSnapshot(user),
    },
    connectionId,
  );

  // ── Lobby fill timer logic (Sub-AC 8c) ─────────────────────────────────────
  // Only run timer logic when a genuinely new player joined (not a reconnect).
  if (!alreadyInLobby) {
    const currentCount = getLobbyPlayers(upperCode).length;

    if (currentCount >= room.player_count) {
      // Lobby is full — cancel any pending timer and start immediately.
      await _handleGameStart(upperCode, room.player_count);
    } else {
      // Lobby still has open seats.
      // Start the 2-minute timer if this is the first player to join.
      if (!isLobbyTimerActive(upperCode)) {
        const { started, expiresAt } = startLobbyTimer(
          upperCode,
          _handleTimerExpiry,
        );
        if (started) {
          broadcastToRoom(upperCode, {
            type:      'lobby-timer-started',
            roomCode:  upperCode,
            expiresAt,
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// kick-player handler
// ---------------------------------------------------------------------------

/**
 * Handle a 'kick-player' message.
 *
 * Expected payload: { type: 'kick-player', roomCode: string, targetPlayerId: string }
 *
 * Server-enforced rules:
 *   - Requester must be the room's host.
 *   - Target must currently be in the lobby.
 *   - Cannot kick oneself.
 *   - Only valid during 'waiting' status (lobby phase).
 *
 * Steps:
 *   1. Validate payload
 *   2. Look up room in DB — verify requester is host, status is 'waiting'
 *   3. Look up target in lobby
 *   4. Send 'you-were-kicked' to the target
 *   5. Remove target from lobby state (both stores)
 *   6. Close the kicked player's WebSocket connection
 *   7. Broadcast 'player-kicked' to all remaining room participants
 *   8. Send 'kick-confirmed' to the host
 *
 * @param {WebSocket} ws
 * @param {string} connectionId
 * @param {{ playerId, displayName, avatarId, isGuest }} user
 * @param {{ type: string, roomCode: string, targetPlayerId: string }} msg
 */
async function handleKickPlayer(ws, connectionId, user, msg) {
  const { roomCode, targetPlayerId } = msg;

  // ── Input validation ───────────────────────────────────────────────────────

  if (!roomCode || typeof roomCode !== 'string' || roomCode.length !== 6) {
    sendJson(ws, { type: 'error', message: 'Invalid roomCode: must be a 6-character string' });
    return;
  }

  if (!targetPlayerId || typeof targetPlayerId !== 'string' || targetPlayerId.trim().length === 0) {
    sendJson(ws, { type: 'error', message: 'targetPlayerId is required' });
    return;
  }

  const upperCode = roomCode.toUpperCase();

  // ── Verify room and host identity ──────────────────────────────────────────

  let room;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('rooms')
      .select('id, code, host_user_id, status')
      .eq('code', upperCode)
      .maybeSingle();

    if (error || !data) {
      sendJson(ws, { type: 'error', message: 'Room not found' });
      return;
    }

    if (data.status !== 'waiting') {
      sendJson(ws, {
        type: 'error',
        code: 'ROOM_NOT_WAITING',
        message: 'Cannot kick players after the game has started',
      });
      return;
    }

    room = data;
  } catch {
    sendJson(ws, { type: 'error', message: 'Internal error verifying room' });
    return;
  }

  // Enforce host-only: requester's playerId must match the DB host_user_id.
  if (user.playerId !== room.host_user_id) {
    sendJson(ws, {
      type:    'error',
      code:    'FORBIDDEN',
      message: 'Only the room host can kick players',
    });
    return;
  }

  // A host cannot kick themselves.
  if (targetPlayerId === user.playerId) {
    sendJson(ws, { type: 'error', message: 'Host cannot kick themselves' });
    return;
  }

  // ── Locate target in lobby ─────────────────────────────────────────────────

  const lobby = getLobby(upperCode);
  if (!lobby) {
    sendJson(ws, { type: 'error', message: 'Lobby not found for this room' });
    return;
  }

  const targetPlayer = lobby.players.get(targetPlayerId);
  if (!targetPlayer) {
    sendJson(ws, {
      type:    'error',
      code:    'PLAYER_NOT_FOUND',
      message: 'Target player is not in the lobby',
    });
    return;
  }

  // ── Perform the kick ───────────────────────────────────────────────────────

  // 1. Notify the kicked player before removing them (socket still open).
  sendJson(targetPlayer.ws, {
    type:     'you-were-kicked',
    roomCode: upperCode,
  });

  // 2. Add the player to the per-room blocklist so they cannot rejoin.
  try {
    blockPlayer(upperCode, targetPlayerId);
  } catch (blockErr) {
    console.error('[kick-player] blockPlayer error:', blockErr);
  }

  // 3. Remove from lobby state (both stores).
  removePlayerFromLobby(upperCode, targetPlayerId);
  lobbyManager.removePlayerFromLobby(upperCode, targetPlayerId);

  // 4. Close the kicked player's WebSocket connection.
  if (targetPlayer.ws.readyState === WebSocket.OPEN) {
    targetPlayer.ws.close(4002, 'Kicked from room');
  }

  // 5. Broadcast 'player-kicked' to all remaining participants.
  broadcastToRoom(upperCode, {
    type:        'player-kicked',
    roomCode:    upperCode,
    playerId:    targetPlayerId,
    displayName: targetPlayer.displayName,
  });

  // 6. Confirm success to the host.
  sendJson(ws, {
    type:     'kick-confirmed',
    roomCode: upperCode,
    playerId: targetPlayerId,
  });
}

// ---------------------------------------------------------------------------
// reassign-team handler (Sub-AC 3a)
// ---------------------------------------------------------------------------

/**
 * Handle a 'reassign-team' message.
 *
 * Expected payload:
 *   { type: 'reassign-team', roomCode: string, targetPlayerId: string, newTeamId: 1|2 }
 *
 * Server-enforced rules:
 *   - Requester must be the room's host (verified against Supabase host_user_id).
 *   - Room must be in 'waiting' status.
 *   - targetPlayerId must exist in the lobbyManager seat map.
 *   - After the move, no team may have more than `playerCount / 2` members
 *     (team-balance validation).
 *
 * Steps:
 *   1. Validate payload fields
 *   2. Look up room in DB — verify status is 'waiting', get host_user_id and player_count
 *   3. Host-only authorization: requester's playerId must equal host_user_id
 *   4. Apply team reassignment via lobbyManager (includes balance check)
 *   5. On success: broadcast 'team-reassigned' to all players in the room
 *   6. On failure: send error back to the requester only
 *
 * @param {WebSocket} ws
 * @param {string}   connectionId
 * @param {{ playerId: string, displayName: string, avatarId: string|null, isGuest: boolean }} user
 * @param {{ type: string, roomCode: string, targetPlayerId: string, newTeamId: 1|2 }} msg
 */
async function handleReassignTeam(ws, connectionId, user, msg) {
  const { roomCode, targetPlayerId, newTeamId } = msg;

  // ── Input validation ───────────────────────────────────────────────────────

  if (!roomCode || typeof roomCode !== 'string' || roomCode.length !== 6) {
    sendJson(ws, {
      type:    'error',
      message: 'Invalid roomCode: must be a 6-character string',
    });
    return;
  }

  if (!targetPlayerId || typeof targetPlayerId !== 'string' || targetPlayerId.trim().length === 0) {
    sendJson(ws, { type: 'error', message: 'targetPlayerId is required' });
    return;
  }

  if (newTeamId !== 1 && newTeamId !== 2) {
    sendJson(ws, {
      type:    'error',
      code:    'INVALID_TEAM_ID',
      message: 'newTeamId must be 1 or 2',
    });
    return;
  }

  const upperCode = roomCode.toUpperCase();

  // ── Verify room status and host identity via Supabase ─────────────────────

  let room;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('rooms')
      .select('id, code, host_user_id, player_count, status')
      .eq('code', upperCode)
      .maybeSingle();

    if (error || !data) {
      sendJson(ws, { type: 'error', message: 'Room not found' });
      return;
    }

    if (data.status !== 'waiting') {
      sendJson(ws, {
        type:    'error',
        code:    'ROOM_NOT_WAITING',
        message: 'Team reassignment is only allowed while the room is waiting to start',
      });
      return;
    }

    room = data;
  } catch {
    sendJson(ws, { type: 'error', message: 'Internal error verifying room' });
    return;
  }

  // ── Host-only authorization ────────────────────────────────────────────────

  if (user.playerId !== room.host_user_id) {
    sendJson(ws, {
      type:    'error',
      code:    'FORBIDDEN',
      message: 'Only the room host can reassign teams',
    });
    return;
  }

  // ── Team-balance-validated reassignment ───────────────────────────────────

  const result = lobbyManager.reassignPlayerTeam(upperCode, targetPlayerId, newTeamId);

  if (!result.success) {
    sendJson(ws, {
      type:    'error',
      code:    'TEAM_BALANCE_VIOLATION',
      message: result.error,
    });
    return;
  }

  // ── Broadcast updated team state to all connected players ─────────────────
  broadcastToRoom(upperCode, {
    type:            'team-reassigned',
    roomCode:        upperCode,
    targetPlayerId,
    newTeamId,
    seats:           result.seats,
  });
}

// ---------------------------------------------------------------------------
// WebSocket server factory
// ---------------------------------------------------------------------------

/**
 * Attach a WebSocket server to an existing Node.js HTTP server.
 *
 * The WS server shares the same port as the Express HTTP server.
 * All connections are authenticated via a `?token=` query parameter.
 *
 * @param {import('http').Server} httpServer - The Node.js HTTP server instance.
 * @returns {WebSocketServer}
 */
function createWsServer(httpServer) {
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', async (ws, req) => {
    // Extract the bearer token from the URL query string.
    const parsed = url.parse(req.url || '', true);
    const token = typeof parsed.query.token === 'string' ? parsed.query.token : null;

    // Resolve identity — reject unauthenticated connections immediately.
    const user = await resolveTokenToUser(token);

    if (!user) {
      sendJson(ws, {
        type:    'error',
        code:    'UNAUTHORIZED',
        message: 'Authentication required: pass a valid ?token= query parameter',
      });
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Assign a stable connection ID for this socket lifetime.
    const connectionId = uuidv4();

    // Route incoming messages.
    ws.on('message', (data) => {
      handleMessage(ws, connectionId, user, data);
    });

    // Clean up lobby state when the connection drops.
    ws.on('close', () => {
      const removed = removeConnectionFromLobby(connectionId);
      if (removed) {
        // Also update lobbyManager connection registry and seat state.
        lobbyManager.removePlayerConnection(removed.roomCode, removed.playerId);

        // Notify remaining players that this person disconnected.
        broadcastToRoom(removed.roomCode, {
          type:        'player-left',
          roomCode:    removed.roomCode,
          playerId:    removed.playerId,
          displayName: removed.displayName,
        });
      }

      // Clean up from any matchmaking queue the player may have been in.
      // This uses the `user` object captured from the connection-time auth
      // resolution — it remains valid for the lifetime of the socket.
      cleanupQueuedPlayer(user.playerId);
    });

    // Acknowledge successful authentication.
    sendJson(ws, {
      type:        'connected',
      playerId:    user.playerId,
      displayName: user.displayName,
    });
  });

  return wss;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createWsServer,

  // Exported for unit testing:
  handleKickPlayer,
  handleJoinRoom,
  handleReassignTeam,
  handleMessage,
  resolveTokenToUser,
  sendJson,
  broadcastToRoom,

  // Exported for timer integration testing:
  _handleGameStart,
  _handleTimerExpiry,

  // Re-exported matchmaking handlers (for integration tests):
  handleJoinQueue,
  handleLeaveQueue,
};
