'use strict';

/**
 * Room WebSocket server — /ws/room/<ROOMCODE>
 *
 * Connection URL format:
 *   ws(s)://host/ws/room/<ROOMCODE>?token=<bearer>
 *
 * Authentication:
 *   Bearer token is resolved against the in-memory guest-session store first,
 *   then against Supabase JWT (same order as auth middleware).
 *
 * Server → Client messages:
 *   { type: 'connected',    userId: string }
 *     Sent immediately after a valid connection is established.
 *
 *   { type: 'room_players', players: RoomPlayer[] }
 *     Broadcast to ALL clients in the room whenever the player list or
 *     team assignments change (join, leave, kick, change_team).
 *
 *   { type: 'kicked', by: string }
 *     Sent to a player just before the server closes their connection.
 *
 *   { type: 'error', message: string }
 *     Non-fatal error response for invalid host commands.
 *
 *   { type: 'lobby-starting', seats: LobbySeat[], roomCode: string }
 *     Broadcast to ALL clients when the host starts the game.
 *     Contains the final seat list (human players + bots for empty seats).
 *     Clients should navigate to the game board upon receiving this message.
 *
 * Client → Server messages:
 *   { type: 'kick_player', targetId: string }
 *     Only accepted from the room host. Kicks the player with the given userId.
 *
 *   { type: 'change_team', teamId: 1|2 }
 *     Any player may switch their own team, subject to capacity constraints.
 *     On success the server broadcasts room_players to everyone.
 *
 *   { type: 'start_game' }
 *     Only accepted from the room host. Fills any empty seats with bots,
 *     updates the room status to 'in_progress' in Supabase, and broadcasts
 *     'lobby-starting' with the final seat list to all connected clients.
 *
 * RoomPlayer wire shape (serialised to clients):
 *   { userId, displayName, isGuest, isHost, teamId: 1|2 }
 *
 * Close codes:
 *   4000 — Invalid room code format
 *   4001 — Unauthorized (missing or invalid token)
 *   4004 — Room not found
 *   4005 — Room not accepting connections
 *   4010 — Kicked by host
 */

const { WebSocketServer } = require('ws');
const url = require('url');
const { getGuestSession } = require('../sessions/guestSessionStore');
const { buildGameSeats } = require('../game/gameInitService');
const { guestHostMap } = require('../routes/rooms');
const { cancelLobbyTimer } = require('../matchmaking/lobbyTimer');
const liveGamesStore = require('../liveGames/liveGamesStore');
const {
  HOST_RECONNECT_WINDOW_MS,
  startHostDisconnectTimer,
  cancelHostDisconnectTimer,
  _clearAllTimers: _clearAllHostDisconnectTimers,
} = require('./hostDisconnectTimer');
const {
  getPendingRematch,
  clearPendingRematch,
  hasPendingRematch,
} = require('../game/pendingRematchStore');

// ---------------------------------------------------------------------------
// Game socket server — lazy-loaded to avoid circular dependency at startup
// ---------------------------------------------------------------------------

let _gameSocketServer = null;

/**
 * Lazy-load the game socket server module.
 * Required to avoid circular dependency: roomSocketServer → gameSocketServer
 * @returns {typeof import('../game/gameSocketServer')}
 */
function _getGameServer() {
  if (!_gameSocketServer) {
    _gameSocketServer = require('../game/gameSocketServer');
  }
  return _gameSocketServer;
}

/**
 * Override the game socket server for tests.
 * @param {Object|null} mock
 */
function _setGameServer(mock) {
  _gameSocketServer = mock;
}

// Idempotency guard: tracks rooms currently going through the start sequence
// to prevent double-starts from concurrent host requests or timer races.
const _startingRooms = new Set();

// ---------------------------------------------------------------------------
// Supabase client (injectable for tests)
// ---------------------------------------------------------------------------

let _supabaseClientFactory = null;

/**
 * Override the Supabase client factory — used in tests only.
 * @param {Function|null} factory  () => supabaseClient  — pass null to reset.
 */
function _setSupabaseClientFactory(factory) {
  _supabaseClientFactory = factory;
}

function getSupabase() {
  if (_supabaseClientFactory) return _supabaseClientFactory();
  return require('../db/supabase').getSupabaseClient();
}

// ---------------------------------------------------------------------------
// In-memory room session store
// ---------------------------------------------------------------------------

/**
 * Map<roomCode, Map<userId, ClientEntry>>
 *
 * ClientEntry:
 *   ws          — live WebSocket
 *   userId      — backend identity (Supabase UUID or guest sessionId)
 *   displayName — player display name
 *   isGuest     — true for guest sessions
 *   isHost      — true for the room creator
 *   teamId      — 1 or 2 (auto-assigned on join, changeable by player)
 *
 * NOTE: spectators are NOT stored here — see roomSpectators below.
 */
const roomClients = new Map();

/**
 * Map<roomCode, Map<userId, SpectatorEntry>>
 *
 * SpectatorEntry:
 *   ws          — live WebSocket
 *   userId      — backend identity (same resolution order as player tokens)
 *   displayName — spectator display name
 *   isGuest     — true for guest sessions
 *   role        — always 'spectator'
 *
 * Spectators are stored separately from players so that:
 *   – They are never counted toward team sizes or player-count limits.
 *   – They receive all broadcast messages (room_players, lobby-starting, etc.).
 *   – Their presence is NOT exposed in room_players snapshots sent to players.
 *   – Permission checks (kick, change_team, start_game) operate only on
 *     the roomClients map, so spectators automatically cannot perform them.
 */
const roomSpectators = new Map();

/**
 * Map<roomCode, { playerCount: number, isMatchmaking: boolean }>
 * Stores room metadata fetched from DB on first join.
 */
const roomMeta = new Map();

/**
 * Map<roomCode, ReturnType<typeof setTimeout>>
 * Auto-start timer handle for matchmaking rooms.
 * Cancelled when the room fills before the timer fires.
 */
const matchmakingTimers = new Map();

/** How long to wait for matched players before filling with bots (30 s). */
const MATCHMAKING_LOBBY_TIMEOUT_MS = 30 * 1000;

/**
 * Map<roomCode, { previousHostId: string }>
 * Tracks pending host-disconnect reconnect windows.  An entry is created when
 * the current room host disconnects from the lobby; it is removed if the same
 * host reconnects before the 60-second window elapses (or when the timer fires
 * and host authority is transferred to the next player).
 *
 * NOTE: The actual timer/tick machinery is managed by hostDisconnectTimer.js.
 * This map only retains the previousHostId so that reconnects can be matched
 * to the correct original host.
 */
const hostTransferTimers = new Map();

/**
 * Map<roomCode, ReturnType<typeof setTimeout>>
 *
 * Sub-AC 45d — Rematch bot-fill timers.
 *
 * Started by startRematchBotFillTimer() immediately after a rematch is agreed
 * (rematch_start broadcast).  Fires after REMATCH_BOT_FILL_TIMEOUT_MS (30 s)
 * if not all original human players have rejoined the room lobby.  On expiry,
 * _executeRematchBotFill() fills absent slots with bots and starts the game.
 *
 * Cancelled by cancelRematchBotFillTimer() if all original humans reconnect
 * before the window expires (in that case _executeRematchBotFill is invoked
 * immediately via process.nextTick).
 */
const _rematchBotFillTimers = new Map();

/**
 * How long to wait for rematch players to reconnect to the lobby before
 * auto-filling absent slots with bots and starting the new game (30 s).
 *
 * Sub-AC 45d: "After the 30-second window, automatically fill any still-absent
 * player slots with bots at the inherited difficulty and start the new game."
 */
const REMATCH_BOT_FILL_TIMEOUT_MS = 30_000;

/**
 * Return (or create) the per-room player client Map.
 * @param {string} roomCode
 * @returns {Map<string, Object>}
 */
function getRoomClientMap(roomCode) {
  if (!roomClients.has(roomCode)) {
    roomClients.set(roomCode, new Map());
  }
  return roomClients.get(roomCode);
}

/**
 * Return (or create) the per-room spectator Map.
 * @param {string} roomCode
 * @returns {Map<string, Object>}
 */
function getRoomSpectatorMap(roomCode) {
  if (!roomSpectators.has(roomCode)) {
    roomSpectators.set(roomCode, new Map());
  }
  return roomSpectators.get(roomCode);
}

/**
 * Auto-assign a team for a newly-joining player.
 *
 * Rules:
 *   - Count current T1 and T2 members in the room.
 *   - Assign to the team with fewer members; tie → Team 1.
 *   - Never exceed playerCount / 2 per team.
 *
 * @param {Map<string, Object>} clients  - current room clients
 * @param {number} playerCount           - max players for the room
 * @returns {1|2}
 */
function autoAssignTeam(clients, playerCount) {
  let t1 = 0;
  let t2 = 0;
  for (const entry of clients.values()) {
    if (entry.teamId === 1) t1++;
    else t2++;
  }
  const max = Math.floor(playerCount / 2);
  if (t1 >= max) return 2;
  if (t2 >= max) return 1;
  return t2 < t1 ? 2 : 1;
}

/**
 * Build the serialisable player list for a room.
 * @param {string} roomCode
 * @returns {Array<{userId, displayName, isGuest, isHost, teamId}>}
 */
function getRoomPlayers(roomCode) {
  const clients = roomClients.get(roomCode);
  if (!clients) return [];
  return Array.from(clients.values()).map(
    ({ userId, displayName, isGuest, isHost, teamId }) => ({
      userId,
      displayName,
      isGuest,
      isHost,
      teamId,
    }),
  );
}

// ---------------------------------------------------------------------------
// Host authority transfer
// ---------------------------------------------------------------------------

/**
 * Start a host-transfer countdown for `roomCode`.
 *
 * If a timer is already running for this room the call is a no-op (guards
 * against network-flap scenarios where disconnect fires twice).
 *
 * @param {string} roomCode
 * @param {string} currentHostId  userId of the host who just disconnected
 */
/**
 * Start the 60-second host-reconnect countdown for a private room.
 *
 * Uses the hostDisconnectTimer module for the actual timer/tick machinery.
 * Broadcasts:
 *   { type: 'host_disconnected', roomCode, expiresAt } — immediately
 *   { type: 'host_disconnect_tick', roomCode, remainingMs, expiresAt } — every 5 s
 *   { type: 'host_timeout', roomCode } — when 60 s elapses without reconnect
 *
 * @param {string} roomCode
 * @param {string} currentHostId
 */
function _startHostTransferTimer(roomCode, currentHostId) {
  // Don't double-start.
  if (hostTransferTimers.has(roomCode)) return;

  console.log(
    `[RoomWS] Host "${currentHostId}" disconnected from room "${roomCode}". ` +
    `Starting ${HOST_RECONNECT_WINDOW_MS / 1000}s host-reconnect timer.`,
  );

  const { started, expiresAt } = startHostDisconnectTimer(
    roomCode,
    // onTick — broadcast countdown every TICK_INTERVAL_MS
    (code, remainingMs, exp) => {
      broadcast(code, {
        type:        'host_disconnect_tick',
        roomCode:    code,
        remainingMs,
        expiresAt:   exp,
      });
    },
    // onExpiry — host did not reconnect within 60 s; transfer authority
    (code) => {
      hostTransferTimers.delete(code);
      broadcast(code, { type: 'host_timeout', roomCode: code });
      _executeHostTransfer(code).catch((err) => {
        console.error(`[RoomWS] Host transfer error for room "${code}":`, err.message);
      });
    },
  );

  if (!started) {
    // Should not happen due to the has() guard above, but be defensive.
    console.warn(`[RoomWS] hostDisconnectTimer already active for room "${roomCode}".`);
    return;
  }

  // Track the previous host ID so reconnects can be matched.
  hostTransferTimers.set(roomCode, { previousHostId: currentHostId });

  // Broadcast the start of the countdown to all remaining clients.
  broadcast(roomCode, {
    type:      'host_disconnected',
    roomCode,
    expiresAt,
  });
}

/**
 * Cancel a pending host-disconnect timer (e.g. because the original host
 * reconnected before the 60-second window elapsed).
 *
 * @param {string} roomCode
 */
function _cancelHostTransferTimer(roomCode) {
  const entry = hostTransferTimers.get(roomCode);
  if (!entry) return;
  cancelHostDisconnectTimer(roomCode);
  hostTransferTimers.delete(roomCode);
  console.log(`[RoomWS] Host-disconnect timer cancelled for room "${roomCode}".`);
}

/**
 * Execute host authority transfer for `roomCode`.
 *
 * Called when the host-transfer timer expires with no reconnect.
 *
 * Algorithm:
 *   1. Select the first remaining player in Map insertion order as new host.
 *   2. Set `isHost = false` on every existing in-memory entry.
 *   3. Set `isHost = true` on the selected entry.
 *   4. Persist the new `host_user_id` to Supabase (best-effort).
 *   5. Broadcast `host_changed` to notify all clients of the new authority.
 *   6. Broadcast `room_players` so all isHost badges refresh.
 *
 * If no players remain the function is a silent no-op.
 *
 * @param {string} roomCode
 * @returns {Promise<void>}
 */
async function _executeHostTransfer(roomCode) {
  const clients = roomClients.get(roomCode);
  if (!clients || clients.size === 0) {
    console.log(`[RoomWS] Host transfer skipped — room "${roomCode}" has no remaining players.`);
    return;
  }

  // Pick the first remaining player in insertion order as the new host.
  const [newHostId, newHostEntry] = Array.from(clients.entries())[0];

  // Clear all existing host flags then promote the selected player.
  for (const entry of clients.values()) {
    entry.isHost = false;
  }
  newHostEntry.isHost = true;

  console.log(
    `[RoomWS] Host authority transferred in room "${roomCode}" → ` +
    `userId="${newHostId}" displayName="${newHostEntry.displayName}".`,
  );

  // Persist to Supabase (best-effort; log but do not throw on failure).
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from('rooms')
      .update({ host_user_id: newHostId })
      .eq('code', roomCode);
    if (error) {
      console.error(`[RoomWS] Supabase host-transfer update failed for room "${roomCode}":`, error.message);
    }
  } catch (err) {
    console.error(`[RoomWS] Supabase host-transfer exception for room "${roomCode}":`, err.message);
  }

  // Notify all connected clients of the authority change.
  broadcast(roomCode, {
    type:        'host_changed',
    newHostId,
    newHostName: newHostEntry.displayName,
  });

  // Broadcast the updated player list so all isHost crown icons refresh.
  broadcast(roomCode, {
    type:          'room_players',
    players:       getRoomPlayers(roomCode),
    isMatchmaking: false, // host transfer only applies to private rooms
  });
}

/**
 * Send a JSON message to every OPEN client in a room — both players AND
 * spectators.  All lobby state transitions (room_players updates, game start)
 * are visible to spectators so they can follow the lobby and navigate to the
 * game page when it starts.
 *
 * @param {string} roomCode
 * @param {Object} message
 */
function broadcast(roomCode, message) {
  const payload = JSON.stringify(message);

  // ── Players ───────────────────────────────────────────────────────────────
  const clients = roomClients.get(roomCode);
  if (clients) {
    for (const entry of clients.values()) {
      if (entry.ws.readyState === 1 /* OPEN */) {
        entry.ws.send(payload);
      }
    }
  }

  // ── Spectators ────────────────────────────────────────────────────────────
  const spectators = roomSpectators.get(roomCode);
  if (spectators) {
    for (const entry of spectators.values()) {
      if (entry.ws.readyState === 1 /* OPEN */) {
        entry.ws.send(payload);
      }
    }
  }
}

/**
 * Send a JSON message to spectators ONLY (not to players).
 * Currently unused internally but exported for use by other modules or tests.
 * @param {string} roomCode
 * @param {Object} message
 */
function broadcastToSpectators(roomCode, message) {
  const spectators = roomSpectators.get(roomCode);
  if (!spectators) return;
  const payload = JSON.stringify(message);
  for (const entry of spectators.values()) {
    if (entry.ws.readyState === 1 /* OPEN */) {
      entry.ws.send(payload);
    }
  }
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a bearer token to a user identity.
 *
 * Resolution order (mirrors auth middleware):
 *   1. Guest session store — cheap in-memory lookup.
 *   2. Supabase JWT — for registered users.
 *
 * @param {string|null} token
 * @returns {Promise<{userId: string, displayName: string, isGuest: boolean}|null>}
 */
async function resolveUserFromToken(token) {
  if (!token) return null;

  // 1. Guest session
  const guestSession = getGuestSession(token);
  if (guestSession) {
    return {
      userId: guestSession.sessionId,
      displayName: guestSession.displayName,
      isGuest: true,
    };
  }

  // 2. Supabase JWT
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;

    const { user } = data;
    const displayName =
      user.user_metadata?.display_name || user.email || 'Unknown';
    return {
      userId: user.id,
      displayName,
      isGuest: false,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Room DB lookup
// ---------------------------------------------------------------------------

const JOINABLE_STATUSES = ['waiting', 'starting'];

/**
 * Fetch minimal room metadata from Supabase — also retrieves spectator_token
 * so the WS connection handler can validate a private-room spectator request.
 *
 * @param {string} roomCode
 * @returns {Promise<{host_user_id: string, status: string, player_count: number, is_matchmaking: boolean, spectator_token: string}|null>}
 */
async function fetchRoomMetaWithToken(roomCode) {
  try {
    const supabase = getSupabase();
    const { data: room, error } = await supabase
      .from('rooms')
      .select('host_user_id, status, player_count, is_matchmaking, spectator_token')
      .eq('code', roomCode)
      .maybeSingle();

    if (error || !room) return null;
    return room;
  } catch {
    return null;
  }
}

/**
 * Fetch minimal room metadata from Supabase (connection-time check).
 * @param {string} roomCode
 * @returns {Promise<{id: string, host_user_id: string, status: string, player_count: number, is_matchmaking: boolean}|null>}
 */
async function fetchRoomMeta(roomCode) {
  try {
    const supabase = getSupabase();
    const { data: room, error } = await supabase
      .from('rooms')
      .select('id, host_user_id, status, player_count, is_matchmaking')
      .eq('code', roomCode)
      .maybeSingle();

    if (error || !room) return null;
    return room;
  } catch {
    return null;
  }
}

/**
 * Fetch full room metadata needed for game creation.
 * @param {string} roomCode
 * @returns {Promise<{
 *   id: string,
 *   host_user_id: string,
 *   status: string,
 *   player_count: number,
 *   card_removal_variant: string,
 *   spectator_token: string,
 * }|null>}
 */
async function fetchRoomMetaFull(roomCode) {
  try {
    const supabase = getSupabase();
    const { data: room, error } = await supabase
      .from('rooms')
      .select('id, host_user_id, status, player_count, card_removal_variant, spectator_token')
      .eq('code', roomCode)
      .maybeSingle();

    if (error || !room) return null;
    return room;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Kick handler (extracted for testability)
// ---------------------------------------------------------------------------

/**
 * Process a kick_player message from a connected client.
 *
 * Rules:
 *   - Only the host may kick.
 *   - Host cannot kick themselves.
 *   - Target must be present in the room.
 *
 * @param {{
 *   ws: import('ws'),
 *   userId: string,
 *   displayName: string,
 *   isHost: boolean,
 *   roomCode: string,
 *   clients: Map<string, Object>
 * }} ctx
 * @param {{ type: string, targetId?: string, payload?: { targetId?: string } }} message
 */
function handleKickPlayer(ctx, message) {
  const { ws, userId, displayName, isHost, roomCode, clients } = ctx;
  // Support both flat { targetId } and wrapped { payload: { targetId } }
  const rawTargetId = message.targetId ?? message.payload?.targetId;
  const targetId =
    typeof rawTargetId === 'string' ? rawTargetId.trim() : null;

  // Authorization
  if (!isHost) {
    ws.send(
      JSON.stringify({ type: 'error', message: 'Only the host can kick players' }),
    );
    return;
  }

  // Validation
  if (!targetId) {
    ws.send(JSON.stringify({ type: 'error', message: 'targetId is required' }));
    return;
  }

  if (targetId === userId) {
    ws.send(
      JSON.stringify({ type: 'error', message: 'Cannot kick yourself' }),
    );
    return;
  }

  const targetEntry = clients.get(targetId);
  if (!targetEntry) {
    ws.send(
      JSON.stringify({ type: 'error', message: 'Player not found in room' }),
    );
    return;
  }

  // Notify and disconnect target
  if (targetEntry.ws.readyState === 1 /* OPEN */) {
    targetEntry.ws.send(
      JSON.stringify({ type: 'kicked', by: displayName }),
    );
    targetEntry.ws.close(4010, 'Kicked by host');
  }

  // Remove from room immediately (before the close event fires)
  clients.delete(targetId);

  // Broadcast updated player list
  broadcast(roomCode, {
    type: 'room_players',
    players: getRoomPlayers(roomCode),
  });
}

// ---------------------------------------------------------------------------
// Change-team handler
// ---------------------------------------------------------------------------

/**
 * Process a change_team message from a connected client.
 *
 * Rules:
 *   - Any player may request a team change for themselves.
 *   - The target team must not already be at capacity (playerCount / 2 members).
 *
 * On success:
 *   - Updates the in-memory teamId for the requesting player.
 *   - Broadcasts room_players to ALL clients in the room (including the sender).
 *
 * @param {{
 *   ws: import('ws'),
 *   userId: string,
 *   roomCode: string,
 *   clients: Map<string, Object>
 * }} ctx
 * @param {{ type: string, teamId?: number, payload?: { teamId?: number } }} message
 */
function handleChangeTeam(ctx, message) {
  const { ws, userId, roomCode, clients } = ctx;

  // Support both flat { teamId } and wrapped { payload: { teamId } }
  const rawTeamId = message.teamId ?? message.payload?.teamId;
  const teamId = Number(rawTeamId);

  if (teamId !== 1 && teamId !== 2) {
    ws.send(
      JSON.stringify({ type: 'error', message: 'teamId must be 1 or 2' }),
    );
    return;
  }

  const entry = clients.get(userId);
  if (!entry) {
    ws.send(
      JSON.stringify({ type: 'error', message: 'Player not found in room' }),
    );
    return;
  }

  // No-op: already on the requested team
  if (entry.teamId === teamId) return;

  // Check capacity
  const meta = roomMeta.get(roomCode);
  const playerCount = meta?.playerCount || 6;
  const maxPerTeam = Math.floor(playerCount / 2);

  let targetTeamCount = 0;
  for (const e of clients.values()) {
    if (e.teamId === teamId) targetTeamCount++;
  }

  if (targetTeamCount >= maxPerTeam) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: `Team ${teamId} is full (max ${maxPerTeam} players)`,
      }),
    );
    return;
  }

  // Apply the change
  entry.teamId = teamId;

  // Broadcast updated player list to ALL clients (including the requester)
  broadcast(roomCode, {
    type: 'room_players',
    players: getRoomPlayers(roomCode),
  });
}

// ---------------------------------------------------------------------------
// Reassign-team handler (host-driven, Sub-AC 3c)
// ---------------------------------------------------------------------------

/**
 * Process a reassign_team message from the host.
 *
 * Allows the room host to move any OTHER player to a different team, subject
 * to the same per-team capacity constraint used by handleChangeTeam.
 *
 * Rules:
 *   - Only the host may reassign.
 *   - Host cannot reassign themselves (use change_team instead).
 *   - Target must be present in the room.
 *   - Target team must not already be at capacity (playerCount / 2).
 *
 * @param {{
 *   ws: import('ws'),
 *   userId: string,
 *   isHost: boolean,
 *   roomCode: string,
 *   clients: Map<string, Object>
 * }} ctx
 * @param {{ type: string, targetId?: string, teamId?: number, payload?: { targetId?: string, teamId?: number } }} message
 */
function handleReassignTeam(ctx, message) {
  const { ws, userId, isHost, roomCode, clients } = ctx;

  // Support both flat { targetId, teamId } and wrapped { payload: { ... } }
  const rawTargetId = message.targetId ?? message.payload?.targetId;
  const targetId =
    typeof rawTargetId === 'string' ? rawTargetId.trim() : null;

  const rawTeamId = message.teamId ?? message.payload?.teamId;
  const teamId = Number(rawTeamId);

  // Authorization
  if (!isHost) {
    ws.send(
      JSON.stringify({ type: 'error', message: 'Only the host can reassign teams' }),
    );
    return;
  }

  // Validation
  if (!targetId) {
    ws.send(JSON.stringify({ type: 'error', message: 'targetId is required' }));
    return;
  }

  if (teamId !== 1 && teamId !== 2) {
    ws.send(
      JSON.stringify({ type: 'error', message: 'teamId must be 1 or 2' }),
    );
    return;
  }

  if (targetId === userId) {
    ws.send(
      JSON.stringify({ type: 'error', message: 'Use change_team to switch your own team' }),
    );
    return;
  }

  const targetEntry = clients.get(targetId);
  if (!targetEntry) {
    ws.send(
      JSON.stringify({ type: 'error', message: 'Player not found in room' }),
    );
    return;
  }

  // No-op: target is already on the requested team
  if (targetEntry.teamId === teamId) return;

  // Check capacity
  const meta = roomMeta.get(roomCode);
  const playerCount = meta?.playerCount || 6;
  const maxPerTeam = Math.floor(playerCount / 2);

  let targetTeamCount = 0;
  for (const e of clients.values()) {
    if (e.teamId === teamId) targetTeamCount++;
  }

  if (targetTeamCount >= maxPerTeam) {
    ws.send(
      JSON.stringify({
        type: 'error',
        message: `Team ${teamId} is full (max ${maxPerTeam} players)`,
      }),
    );
    return;
  }

  // Apply the reassignment
  targetEntry.teamId = teamId;

  // Broadcast updated player list to ALL clients (including the host)
  broadcast(roomCode, {
    type: 'room_players',
    players: getRoomPlayers(roomCode),
  });
}

// ---------------------------------------------------------------------------
// Game-start validation helpers (Sub-AC 5.2)
// ---------------------------------------------------------------------------

/**
 * Validate whether the current player state permits starting the game.
 *
 * Server-enforced rules:
 *   1. At least one human player must be present (host must be connected).
 *   2. Total human player count must not exceed the configured playerCount (6 or 8).
 *   3. Neither team may have more than Math.floor(playerCount / 2) human
 *      players — remaining seats are filled by bots in the alternating layout,
 *      so exceeding the per-team cap would produce an unbalanced game.
 *
 * This function is pure (no side-effects) and is called by both the WebSocket
 * handler (start_game message) and the REST endpoint POST /api/rooms/:code/start.
 *
 * @param {Map<string, Object>} clients      Current room clients (userId → entry).
 * @param {number}              playerCount  Room's configured player count (6 or 8).
 * @returns {{ valid: boolean, error?: string, errorCode?: string }}
 */
function validateStartGame(clients, playerCount) {
  const humanCount = clients.size;

  if (humanCount === 0) {
    return {
      valid:     false,
      error:     'At least one player must be in the room to start the game',
      errorCode: 'NO_PLAYERS',
    };
  }

  if (humanCount > playerCount) {
    return {
      valid:     false,
      error:     `Too many players: ${humanCount} exceeds the room capacity of ${playerCount}`,
      errorCode: 'TOO_MANY_PLAYERS',
    };
  }

  const maxPerTeam = Math.floor(playerCount / 2);
  let team1Count = 0;
  let team2Count = 0;

  for (const entry of clients.values()) {
    if (entry.teamId === 1) team1Count++;
    else team2Count++;
  }

  if (team1Count > maxPerTeam) {
    return {
      valid:     false,
      error:     `Team 1 has ${team1Count} players but the maximum per team is ${maxPerTeam} for a ${playerCount}-player game. Please rebalance the teams before starting.`,
      errorCode: 'TEAM_IMBALANCED',
    };
  }

  if (team2Count > maxPerTeam) {
    return {
      valid:     false,
      error:     `Team 2 has ${team2Count} players but the maximum per team is ${maxPerTeam} for a ${playerCount}-player game. Please rebalance the teams before starting.`,
      errorCode: 'TEAM_IMBALANCED',
    };
  }

  return { valid: true };
}

/**
 * Convert the current room clients to a sorted LobbySeat array
 * (human players only — bots are appended by fillWithBots afterwards).
 *
 * This is an array-returning wrapper around buildOccupiedSeats() for callers
 * that need an Array rather than a Map (e.g. the REST endpoint).
 *
 * @param {Map<string, Object>} clients      Current room clients.
 * @param {number}              playerCount  Room's configured player count.
 * @returns {Array<Object>}  Human-only seat descriptors, sorted by seatIndex.
 */
function buildSeatsFromClients(clients, playerCount) {
  const occupiedMap = buildOccupiedSeats(clients, playerCount);
  return Array.from(occupiedMap.values()).sort((a, b) => a.seatIndex - b.seatIndex);
}

// ---------------------------------------------------------------------------
// Start-game handler (host-driven, Sub-AC 5.2)
// ---------------------------------------------------------------------------

/**
 * Build a Map<seatIndex, LobbySeat> from the current live client map.
 *
 * Rules (mirrors the visual seat layout):
 *   - Team-1 clients → even seat indices: 0, 2, 4, 6
 *   - Team-2 clients → odd  seat indices: 1, 3, 5, 7
 *
 * The n-th Team-1 player gets seat n*2; the n-th Team-2 player gets n*2+1.
 * Only the first (playerCount/2) members per team are assigned seats; extra
 * players are dropped (which should not occur under normal lobby rules).
 *
 * @param {Map<string, Object>} clients     - Current roomClients map for the room.
 * @param {number}              playerCount - Total seat capacity (6 or 8).
 * @returns {Map<number, Object>}           - seatIndex → LobbySeat-shaped object.
 */
function buildOccupiedSeats(clients, playerCount) {
  const t1 = [];
  const t2 = [];
  for (const entry of clients.values()) {
    if (entry.teamId === 1) t1.push(entry);
    else                    t2.push(entry);
  }

  const maxPerTeam = Math.floor(playerCount / 2);

  /** @type {Map<number, Object>} */
  const occupiedSeats = new Map();

  t1.slice(0, maxPerTeam).forEach((p, i) => {
    const seatIndex = i * 2;
    occupiedSeats.set(seatIndex, {
      seatIndex,
      playerId:    p.userId,
      displayName: p.displayName,
      avatarId:    null,
      teamId:      /** @type {1} */ (1),
      isBot:       false,
      isGuest:     p.isGuest,
      isHost:      p.isHost,
    });
  });

  t2.slice(0, maxPerTeam).forEach((p, i) => {
    const seatIndex = i * 2 + 1;
    occupiedSeats.set(seatIndex, {
      seatIndex,
      playerId:    p.userId,
      displayName: p.displayName,
      avatarId:    null,
      teamId:      /** @type {2} */ (2),
      isBot:       false,
      isGuest:     p.isGuest,
      isHost:      p.isHost,
    });
  });

  return occupiedSeats;
}

/**
 * Process a start_game message from the host.
 *
 * This is the primary game-start entry point for clients connected to
 * /ws/room/<CODE>.  It:
 *
 *   1. Verifies the requester is the room host.
 *   2. Fetches full room metadata (id, variant) from Supabase and confirms
 *      the room is still in 'waiting' status.
 *   3. Builds a seat snapshot from the live roomClients map.
 *   4. Fills empty seats with bot players (botFiller.fillWithBots).
 *   5. Creates the in-memory game state via gameSocketServer.createGame().
 *   6. Updates Supabase room status to 'starting' — this prevents new players
 *      from joining via the room WS and signals the game page to accept WS
 *      connections.
 *   7. Broadcasts { type: 'lobby-starting', seats, botsAdded, roomCode } to
 *      ALL connected clients (human players AND spectators) so they navigate
 *      to /game/<roomCode>.
 *   8. Asynchronously persists the game state (transitions status → 'in_progress').
 *   9. Schedules the first bot turn if the opening player is a bot.
 *
 * @param {{
 *   ws:       import('ws'),
 *   userId:   string,
 *   isHost:   boolean,
 *   roomCode: string,
 *   clients:  Map<string, Object>
 * }} ctx
 */
async function handleStartGame(ctx) {
  const { ws, isHost, roomCode, clients } = ctx;

  // ── Idempotency guard ──────────────────────────────────────────────────────
  // Prevent duplicate game-start sequences from concurrent calls.
  if (_startingRooms.has(roomCode)) {
    ws.send(
      JSON.stringify({
        type:    'error',
        code:    'ALREADY_STARTING',
        message: 'Game start is already in progress for this room',
      }),
    );
    return;
  }
  _startingRooms.add(roomCode);

  try {
    // ── Fetch full room metadata from Supabase ────────────────────────────────
    const dbRoom = await fetchRoomMetaFull(roomCode);
    if (!dbRoom) {
      ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
      return;
    }

    if (dbRoom.status !== 'waiting') {
      ws.send(
        JSON.stringify({
          type:    'error',
          code:    'ROOM_NOT_WAITING',
          message: 'Game has already started or room is no longer active',
        }),
      );
      return;
    }

    const playerCount = dbRoom.player_count || 6;
    const variant     = dbRoom.card_removal_variant || 'remove_7s';
    const roomId      = dbRoom.id;

    // ── Validate player count and team balance (Sub-AC 5.2) ───────────────────
    // Server-enforced: checks that no team exceeds playerCount/2 humans and that
    // the lobby is not empty.  Bots will fill any remaining empty seats.
    const validation = validateStartGame(clients, playerCount);
    if (!validation.valid) {
      ws.send(
        JSON.stringify({
          type:    'error',
          message: validation.error,
          code:    validation.errorCode,
        }),
      );
      return;
    }

    // ── Build seat snapshot from live roomClients map ──────────────────────────
    const occupiedSeats = buildOccupiedSeats(clients, playerCount);

    // ── Detect empty seats and auto-fill with bots (gameInitService) ──────────
    // buildGameSeats() calls detectEmptySeats() + buildBotSeats() internally,
    // then merges and sorts the final seat array.  emptySlots is logged for
    // diagnostics; allSeats and botSeats drive the broadcast and createGame.
    const { allSeats, botSeats, emptySlots } = buildGameSeats(playerCount, occupiedSeats);
    const bots = botSeats; // alias kept for the botsAdded broadcast field

    if (emptySlots.length > 0) {
      console.log(
        `[RoomWS] handleStartGame: ${emptySlots.length} empty seat(s) detected in room ` +
        `${roomCode} — filling with bots at indices: ${emptySlots.join(', ')}`
      );
    }

    // ── Cancel any active lobby fill timer ────────────────────────────────────
    // Safe to call even if no timer is active (cancelLobbyTimer is idempotent).
    try {
      cancelLobbyTimer(roomCode);
    } catch (err) {
      console.error('[RoomWS] handleStartGame: cancelLobbyTimer error (non-fatal):', err);
    }

    // ── Update Supabase room status to 'starting' ─────────────────────────────
    // 'starting' keeps the room joinable for late-connecting clients but signals
    // that the game is transitioning.  persistGameState (called below) will then
    // move it to 'in_progress' once the snapshot is stored.
    //
    // Two failure modes:
    //   • Resolved with { error } (Supabase constraint/policy error) — fatal:
    //     send an error to the host and abort (the room state is indeterminate).
    //   • Thrown / rejected (network outage, connection refused) — non-fatal:
    //     log and continue so connected clients are not stranded mid-lobby.
    try {
      const supabase = getSupabase();
      const { error: updateErr } = await supabase
        .from('rooms')
        .update({ status: 'starting' })
        .eq('code', roomCode);
      if (updateErr) {
        console.error('[RoomWS] handleStartGame: Supabase status update failed for room', roomCode, ':', updateErr);
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to start game. Please try again.' }));
        return;
      }
    } catch (err) {
      // Network / infra error — log but continue; clients are still waiting.
      console.error('[RoomWS] handleStartGame: Supabase status update threw for room', roomCode, ':', err);
    }

    // ── Create in-memory game state ─────────────────────────────────────────────
    let gameState = null;
    try {
      const gameServer = _getGameServer();
      gameState = gameServer.createGame({
        roomCode,
        roomId,
        variant,
        playerCount,
        spectatorUrl: dbRoom?.spectator_token
          ? `/game/${roomCode}?spectatorToken=${encodeURIComponent(dbRoom.spectator_token)}`
          : undefined,
        seats: allSeats,
      });
    } catch (err) {
      console.error('[RoomWS] handleStartGame: createGame failed for room', roomCode, ':', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to initialise game. Please try again.' }));
      return;
    }

    // ── Broadcast 'lobby-starting' to ALL clients (players AND spectators) ──────
    // This event triggers navigation to /game/<roomCode> in all connected
    // browsers, including any spectators watching the lobby.
    broadcast(roomCode, {
      type:      'lobby-starting',
      roomCode,
      seats:     allSeats,
      botsAdded: bots.map((b) => b.playerId),
    });

    // ── Persist game state asynchronously ──────────────────────────────────────
    // Runs after the broadcast so clients start navigating immediately.
    // persistGameState sets the final room status to 'in_progress' in Supabase
    // and stores the game_state JSON snapshot for crash recovery.
    if (gameState) {
      process.nextTick(async () => {
        try {
          const { persistGameState } = require('../game/gameState');
          const supabase = getSupabase();
          await persistGameState(gameState, supabase);
          console.log(`[RoomWS] Game state persisted for room ${roomCode}`);
        } catch (err) {
          console.error('[RoomWS] handleStartGame: persistGameState failed for room', roomCode, ':', err);
        }
      });

      // ── Schedule first bot turn if opening player is a bot ──────────────────
      // The delay gives clients 3 s to connect to /ws/game/<CODE> before the
      // bot fires — matching the timing used in wsServer._handleGameStart.
      const firstPlayer = gameState.players.find(
        (p) => p.playerId === gameState.currentTurnPlayerId,
      );
      if (firstPlayer && firstPlayer.isBot) {
        setTimeout(() => {
          try {
            const gameServer = _getGameServer();
            gameServer.scheduleBotTurnIfNeeded(gameState);
          } catch (err) {
            console.error('[RoomWS] handleStartGame: scheduleBotTurn error:', err);
          }
        }, 3000);
      }
    }
  } finally {
    // Always release the idempotency lock so a retry is possible if needed.
    _startingRooms.delete(roomCode);
  }
}

// ---------------------------------------------------------------------------
// Matchmaking auto-start
// ---------------------------------------------------------------------------

/**
 * Auto-start a matchmaking room without requiring a host action.
 *
 * Functionally identical to handleStartGame but skips the host-authorization
 * check.  Called automatically either when all matched players join or when
 * the 30-second fill timer fires.
 *
 * @param {string}            roomCode
 * @param {Map<string, Object>} clients
 * @param {number}            playerCount
 */
async function handleAutoStartMatchmaking(roomCode, clients, playerCount) {
  console.log(`[RoomWS] handleAutoStartMatchmaking: starting room ${roomCode} (${clients.size}/${playerCount} players).`);

  // ── Fetch full room metadata from Supabase ──────────────────────────────
  const dbRoom = await fetchRoomMetaFull(roomCode);
  if (!dbRoom) {
    console.error(`[RoomWS] handleAutoStartMatchmaking: room ${roomCode} not found in DB.`);
    return;
  }

  if (dbRoom.status !== 'waiting' && dbRoom.status !== 'starting') {
    // Room already started or cancelled — nothing to do.
    console.log(`[RoomWS] handleAutoStartMatchmaking: room ${roomCode} is already '${dbRoom.status}' — skipping.`);
    return;
  }

  const count   = dbRoom.player_count || playerCount;
  const variant = dbRoom.card_removal_variant || 'remove_7s';
  const roomId  = dbRoom.id;

  // ── Build seat snapshot from current live clients ────────────────────────
  const occupiedSeats = buildOccupiedSeats(clients, count);

  // ── Detect empty seats and auto-fill with bots (gameInitService) ─────────
  // buildGameSeats() runs detectEmptySeats() + buildBotSeats() and returns
  // the merged, sorted seat array ready for createGame().
  const { allSeats, botSeats, emptySlots } = buildGameSeats(count, occupiedSeats);
  const bots = botSeats; // alias kept for the botsAdded broadcast field

  if (emptySlots.length > 0) {
    console.log(
      `[RoomWS] handleAutoStartMatchmaking: ${emptySlots.length} empty seat(s) detected ` +
      `in matchmaking room ${roomCode} — filling with bots at indices: ${emptySlots.join(', ')}`
    );
  }

  // ── Create in-memory game state ──────────────────────────────────────────
  let gameState = null;
  try {
    const gameServer = _getGameServer();
    gameState = gameServer.createGame({
      roomCode,
      roomId,
      variant,
      playerCount: count,
      spectatorUrl: dbRoom?.spectator_token
        ? `/game/${roomCode}?spectatorToken=${encodeURIComponent(dbRoom.spectator_token)}`
        : undefined,
      seats: allSeats,
    });
  } catch (err) {
    console.error('[RoomWS] handleAutoStartMatchmaking: createGame failed for room', roomCode, ':', err);
    // Broadcast an error to all clients so they can retry or navigate home
    broadcast(roomCode, { type: 'error', message: 'Failed to initialise game. Please try again.' });
    return;
  }

  // ── Update Supabase room status to 'starting' ────────────────────────────
  try {
    const supabase = getSupabase();
    await supabase.from('rooms').update({ status: 'starting' }).eq('code', roomCode);
  } catch (err) {
    console.error('[RoomWS] handleAutoStartMatchmaking: Supabase status update failed for room', roomCode, ':', err);
    broadcast(roomCode, { type: 'error', message: 'Failed to start game. Please try again.' });
    return;
  }

  // ── Broadcast 'lobby-starting' to all connected clients ─────────────────
  broadcast(roomCode, {
    type:          'lobby-starting',
    roomCode,
    seats:         allSeats,
    botsAdded:     bots.map((b) => b.playerId),
    isMatchmaking: true,
  });

  // ── Update live games store: game is now in_progress ────────────────────
  liveGamesStore.updateGame(roomCode, {
    status:         'in_progress',
    startedAt:      Date.now(),
    currentPlayers: allSeats.length,
  });

  // ── Persist game state asynchronously ───────────────────────────────────
  if (gameState) {
    process.nextTick(async () => {
      try {
        const { persistGameState } = require('../game/gameState');
        const supabase = getSupabase();
        await persistGameState(gameState, supabase);
        console.log(`[RoomWS] Matchmaking game state persisted for room ${roomCode}`);
      } catch (err) {
        console.error('[RoomWS] handleAutoStartMatchmaking: persistGameState failed for room', roomCode, ':', err);
      }
    });

    // Schedule first bot turn if the opening player is a bot.
    const firstPlayer = gameState.players.find(
      (p) => p.playerId === gameState.currentTurnPlayerId,
    );
    if (firstPlayer && firstPlayer.isBot) {
      setTimeout(() => {
        try {
          const gameServer = _getGameServer();
          gameServer.scheduleBotTurnIfNeeded(gameState);
        } catch (err) {
          console.error('[RoomWS] handleAutoStartMatchmaking: scheduleBotTurn error:', err);
        }
      }, 3000);
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-AC 45d — Rematch bot-fill timer
// ---------------------------------------------------------------------------

/**
 * Start the 30-second window for rematch players to reconnect to the room lobby.
 *
 * Called by gameSocketServer.handleRematchVote immediately after broadcasting
 * `rematch_start`.  If all original human players reconnect before the window
 * expires the timer is cancelled and _executeRematchBotFill() runs immediately
 * via process.nextTick.  Otherwise it fires after REMATCH_BOT_FILL_TIMEOUT_MS
 * and absent slots are replaced by bots.
 *
 * The pending rematch settings (players, variant, playerCount, inferenceMode)
 * MUST already be stored in pendingRematchStore before calling this function.
 *
 * @param {string} roomCode
 */
function startRematchBotFillTimer(roomCode) {
  const code = roomCode.toUpperCase();

  // Cancel any lingering timer from a previous rematch cycle.
  cancelRematchBotFillTimer(code);

  const pending = getPendingRematch(code);
  if (!pending) {
    console.warn('[RoomWS] startRematchBotFillTimer: no pending rematch settings for room', code);
    return;
  }

  const humanPlayers = pending.players.filter((p) => !p.isBot);
  const clients      = getRoomClientMap(code);

  // ── All-bot game: no humans to wait for → start immediately ──────────────
  if (humanPlayers.length === 0) {
    console.log(
      `[RoomWS] Rematch room ${code}: all-bot roster — starting immediately (no humans to wait for).`
    );
    process.nextTick(() => {
      _executeRematchBotFill(code).catch((err) => {
        console.error('[RoomWS] _executeRematchBotFill (all-bot) error for room', code, ':', err);
      });
    });
    return;
  }

  // ── Fast path: all human players already in the lobby ────────────────────
  const connectedCount = Array.from(clients.keys()).filter((uid) =>
    humanPlayers.some((hp) => hp.playerId === uid)
  ).length;

  if (connectedCount >= humanPlayers.length) {
    console.log(
      `[RoomWS] Rematch room ${code}: all ${humanPlayers.length} human(s) already present — ` +
      `starting immediately.`
    );
    process.nextTick(() => {
      _executeRematchBotFill(code).catch((err) => {
        console.error('[RoomWS] _executeRematchBotFill (immediate) error for room', code, ':', err);
      });
    });
    return;
  }

  // ── Normal path: start 30-second wait ────────────────────────────────────
  console.log(
    `[RoomWS] Rematch room ${code}: starting ${REMATCH_BOT_FILL_TIMEOUT_MS / 1000}s bot-fill ` +
    `window (${connectedCount}/${humanPlayers.length} human(s) present).`
  );

  const handle = setTimeout(() => {
    _rematchBotFillTimers.delete(code);
    const currentClients = getRoomClientMap(code);
    _executeRematchBotFill(code, currentClients).catch((err) => {
      console.error('[RoomWS] _executeRematchBotFill (timer) error for room', code, ':', err);
    });
  }, REMATCH_BOT_FILL_TIMEOUT_MS);

  if (handle.unref) handle.unref();
  _rematchBotFillTimers.set(code, handle);
}

/**
 * Cancel the rematch bot-fill timer for a room (if one is pending).
 * Leaves the pendingRematchStore entry intact — the caller is responsible for
 * clearing that once the game has started (or if the rematch is abandoned).
 *
 * @param {string} roomCode
 */
function cancelRematchBotFillTimer(roomCode) {
  const code   = roomCode.toUpperCase();
  const handle = _rematchBotFillTimers.get(code);
  if (handle) {
    clearTimeout(handle);
    _rematchBotFillTimers.delete(code);
  }
}

/**
 * Execute the rematch bot-fill: check which original human players have
 * reconnected to the room lobby, fill absent slots with bots, and start the
 * new game.
 *
 * Bot difficulty is "inherited" from the previous game — since all bots
 * currently use the same default behaviour this is a no-op today, but the
 * architecture is designed so that a `difficulty` field on each bot seat can
 * be propagated here once difficulty tiers are introduced.
 *
 * @param {string}              roomCode
 * @param {Map<string, Object>} [clientsOverride] - Optional clients Map (defaults to live roomClients).
 * @returns {Promise<void>}
 */
async function _executeRematchBotFill(roomCode, clientsOverride) {
  const code = roomCode.toUpperCase();

  // ── Guard: check pending rematch metadata exists ──────────────────────────
  const pending = getPendingRematch(code);
  if (!pending) {
    console.log(`[RoomWS] _executeRematchBotFill: no pending rematch for room ${code} — skipping.`);
    return;
  }

  const { players: originalPlayers, variant, playerCount, inferenceMode } = pending;

  // ── Fetch room metadata (id, current status) from Supabase ───────────────
  const dbRoom = await fetchRoomMetaFull(code);
  if (!dbRoom) {
    console.error(`[RoomWS] _executeRematchBotFill: room ${code} not found in DB.`);
    clearPendingRematch(code);
    return;
  }

  // Guard against double-starts (e.g. if createGame was somehow called twice).
  if (dbRoom.status !== 'waiting') {
    console.log(
      `[RoomWS] _executeRematchBotFill: room ${code} is already '${dbRoom.status}' — skipping.`
    );
    clearPendingRematch(code);
    return;
  }

  // Idempotency: prevent re-entry if the room is already in the starting set.
  if (_startingRooms.has(code)) {
    console.log(`[RoomWS] _executeRematchBotFill: room ${code} already starting — skipping.`);
    return;
  }
  _startingRooms.add(code);

  try {
    const roomId  = dbRoom.id;
    const clients = clientsOverride != null ? clientsOverride : getRoomClientMap(code);

    // ── Build occupied-seats Map from reconnected human players ───────────────
    // Only include clients that were part of the original game (by playerId).
    // Bot slots from the previous game are left unoccupied so the bot filler
    // can regenerate them with fresh IDs (same or different bot names).
    const originalHumanIds = new Set(
      originalPlayers.filter((p) => !p.isBot).map((p) => p.playerId)
    );

    const occupiedSeats = new Map();
    for (const [uid, clientEntry] of clients) {
      if (!originalHumanIds.has(uid)) continue; // Not part of the original game

      // Look up the player's original seat assignment (seatIndex + teamId).
      const prev = originalPlayers.find((p) => p.playerId === uid);
      if (!prev) continue;

      occupiedSeats.set(prev.seatIndex, {
        seatIndex:   prev.seatIndex,
        playerId:    uid,
        displayName: clientEntry.displayName,
        avatarId:    null,
        teamId:      prev.teamId,    // Preserve original team assignment
        isBot:       false,
        isGuest:     clientEntry.isGuest,
      });
    }

    // ── Fill absent slots with bots ───────────────────────────────────────────
    const { allSeats, botSeats, emptySlots } = buildGameSeats(playerCount, occupiedSeats);

    if (emptySlots.length > 0) {
      console.log(
        `[RoomWS] Rematch room ${code}: ${emptySlots.length} absent slot(s) ` +
        `filled with bots at indices: ${emptySlots.join(', ')}`
      );
    }

    // ── Create in-memory game state ────────────────────────────────────────────
    let gameState = null;
    try {
      const gameServer = _getGameServer();
      gameState = gameServer.createGame({
        roomCode:    code,
        roomId,
        variant,
        playerCount,
        spectatorUrl: dbRoom.spectator_token
          ? `/game/${code}?spectatorToken=${encodeURIComponent(dbRoom.spectator_token)}`
          : undefined,
        seats:       allSeats,
        inferenceMode,
      });
    } catch (err) {
      console.error('[RoomWS] _executeRematchBotFill: createGame failed for room', code, ':', err);
      broadcast(code, { type: 'error', message: 'Failed to start rematch. Please try again.' });
      return;
    }

    // ── Update Supabase room status to 'in_progress' ──────────────────────────
    try {
      const supabase = getSupabase();
      await supabase.from('rooms').update({ status: 'in_progress' }).eq('code', code);
    } catch (err) {
      console.error(
        '[RoomWS] _executeRematchBotFill: Supabase status update failed for room', code, ':', err
      );
      // Non-fatal — continue so the in-memory game starts even if the DB update fails.
    }

    // ── Broadcast lobby-starting to all connected clients ─────────────────────
    broadcast(code, {
      type:      'lobby-starting',
      roomCode:  code,
      seats:     allSeats,
      botsAdded: botSeats.map((b) => b.playerId),
      isRematch: true,
    });

    console.log(
      `[RoomWS] Rematch room ${code}: new game started — ` +
      `${allSeats.length} seats (${botSeats.length} bot(s)), variant=${variant}`
    );

    // ── Persist game state asynchronously ─────────────────────────────────────
    if (gameState) {
      process.nextTick(async () => {
        try {
          const { persistGameState } = require('../game/gameState');
          const supabase = getSupabase();
          await persistGameState(gameState, supabase);
          console.log(`[RoomWS] Rematch game state persisted for room ${code}`);
        } catch (err) {
          console.error('[RoomWS] _executeRematchBotFill: persistGameState failed for room', code, ':', err);
        }
      });

      // ── Schedule first bot turn if opening player is a bot ────────────────
      const firstPlayer = gameState.players.find(
        (p) => p.playerId === gameState.currentTurnPlayerId
      );
      if (firstPlayer && firstPlayer.isBot) {
        setTimeout(() => {
          try {
            const gameServer = _getGameServer();
            gameServer.scheduleBotTurnIfNeeded(gameState);
          } catch (err) {
            console.error('[RoomWS] _executeRematchBotFill: scheduleBotTurn error:', err);
          }
        }, 3000);
      }
    }
  } finally {
    // Always clear idempotency guard and pending rematch (regardless of success/failure).
    // Clearing here ensures: (a) the next rematch cycle can run, and (b) stale pending
    // state doesn't interfere with subsequent room operations.
    _startingRooms.delete(code);
    clearPendingRematch(code);
  }
}

// ---------------------------------------------------------------------------
// WebSocket server factory
// ---------------------------------------------------------------------------

/**
 * Attach a room WebSocket server to the given HTTP server.
 *
 * Listens at path `/ws/room/<ROOMCODE>?token=<bearer>`.
 * Uses the `upgrade` event on the HTTP server for path-based routing so
 * dynamic room codes can be captured without pre-configuring paths.
 *
 * @param {import('http').Server} httpServer
 * @returns {WebSocketServer}
 */
function attachRoomSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  // ── Route HTTP upgrade requests to this WS server ────────────────────────
  httpServer.on('upgrade', (req, socket, head) => {
    const parsed = url.parse(req.url || '', true);
    const match = parsed.pathname.match(/^\/ws\/room\/([A-Za-z0-9]{6})$/);

    if (!match) {
      // Not our path — let the next registered upgrade handler deal with it
      // (e.g. the legacy /ws lobby server).  Do NOT destroy the socket here.
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  // ── Handle each WebSocket connection ─────────────────────────────────────
  wss.on('connection', async (ws, req) => {
    const parsed = url.parse(req.url || '', true);

    // Extract room code from URL path
    const match = parsed.pathname.match(/^\/ws\/room\/([A-Za-z0-9]{6})$/);
    const roomCode = match ? match[1].toUpperCase() : null;

    // Extract bearer token from query string
    const token =
      typeof parsed.query.token === 'string' ? parsed.query.token : null;

    // Extract optional role and spectator_token query params.
    //   role=spectator          → the client wants spectator-only access
    //   spectator_token=<hex>   → 32-char token proving private-room access
    const role           = typeof parsed.query.role === 'string' ? parsed.query.role : null;
    const spectatorToken = typeof parsed.query.spectator_token === 'string'
      ? parsed.query.spectator_token
      : null;
    const isSpectatorRequest = role === 'spectator';

    // ── Validate room code ──────────────────────────────────────────────────
    if (!roomCode || !/^[A-Z0-9]{6}$/.test(roomCode)) {
      ws.close(4000, 'Invalid room code');
      return;
    }

    // ── Resolve identity from bearer token ─────────────────────────────────
    const userInfo = await resolveUserFromToken(token);
    if (!userInfo) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const { userId, displayName, isGuest } = userInfo;

    // ── Verify room exists and is joinable ──────────────────────────────────
    // For spectator connections we also need the spectator_token from the DB
    // to validate private-room access, so use the extended fetch.
    const dbRoom = isSpectatorRequest
      ? await fetchRoomMetaWithToken(roomCode)
      : await fetchRoomMeta(roomCode);

    if (!dbRoom) {
      ws.close(4004, 'Room not found');
      return;
    }
    if (!JOINABLE_STATUSES.includes(dbRoom.status)) {
      ws.close(4005, 'Room not accepting connections');
      return;
    }

    // ── Store room metadata (playerCount + matchmaking flag) ────────────────
    if (!roomMeta.has(roomCode)) {
      roomMeta.set(roomCode, {
        playerCount:   dbRoom.player_count || 6,
        // Coerce undefined (rooms without column yet) to false.
        isMatchmaking: !!dbRoom.is_matchmaking,
      });
    }

    const meta = roomMeta.get(roomCode);
    const isMatchmakingRoom = !!(meta?.isMatchmaking);

    // ── ─────────────────────────────────────────────────────────────────────
    //    SPECTATOR BRANCH
    //    Stored in roomSpectators — never counted toward team or player-count
    //    limits, never visible in room_players, cannot send game commands.
    // ── ─────────────────────────────────────────────────────────────────────
    if (isSpectatorRequest) {
      // Private rooms require the spectator_token to prevent uninvited viewers.
      // Matchmaking rooms are public, so no token is needed.
      if (!isMatchmakingRoom) {
        const storedToken = dbRoom.spectator_token || '';
        const providedToken = (spectatorToken || '').toUpperCase();
        if (!providedToken || providedToken !== storedToken.toUpperCase()) {
          ws.close(4003, 'Invalid spectator token');
          return;
        }
      }

      // Register in the spectator map (separate from player clients).
      const spectators = getRoomSpectatorMap(roomCode);
      spectators.set(userId, { ws, userId, displayName, isGuest, role: 'spectator' });

      // Confirm spectator connection.
      ws.send(JSON.stringify({ type: 'connected', userId, role: 'spectator' }));

      // Send the current player list so spectators see who is already in the lobby.
      ws.send(JSON.stringify({
        type:          'room_players',
        players:       getRoomPlayers(roomCode),
        isMatchmaking: isMatchmakingRoom,
      }));

      // Spectator message handler: reject all commands.
      ws.on('message', () => {
        ws.send(JSON.stringify({
          type:    'error',
          code:    'SPECTATOR',
          message: 'Spectators cannot send commands to the lobby',
        }));
      });

      // Spectator disconnect handler.
      ws.on('close', () => {
        const specMap = roomSpectators.get(roomCode);
        if (specMap) {
          specMap.delete(userId);
          if (specMap.size === 0) {
            roomSpectators.delete(roomCode);
          }
        }
      });

      ws.on('error', (err) => {
        console.error(
          `[RoomWS] Spectator error for user="${userId}" room="${roomCode}": ${err.message}`,
        );
      });

      return; // Early return — spectator path is fully handled above.
    }

    // ── ─────────────────────────────────────────────────────────────────────
    //    PLAYER BRANCH (normal join)
    // ── ─────────────────────────────────────────────────────────────────────

    // ── Determine host status ───────────────────────────────────────────────
    // Matchmaking rooms have no designated host — all players are peers.
    // For guests, host_user_id is null in DB; check the in-memory guestHostMap instead.
    const isHost = isMatchmakingRoom
      ? false
      : (dbRoom.host_user_id === userId || guestHostMap.get(dbRoom.id) === userId);

    // ── Auto-assign team ────────────────────────────────────────────────────
    const clients = getRoomClientMap(roomCode);
    const playerCount = meta ? meta.playerCount : 6;

    // Team assignment priority:
    //   1. Existing in-memory entry (reconnect / tab refresh) — preserves current teamId.
    //   2. Pending rematch entry — restores the player's team from the previous game.
    //   3. Auto-assign — for fresh joins with no prior context.
    const existingEntry = clients.get(userId);
    let teamId;
    if (existingEntry) {
      teamId = existingEntry.teamId;
    } else {
      const pendingRematch = hasPendingRematch(roomCode) ? getPendingRematch(roomCode) : null;
      const rematchPlayer  = pendingRematch?.players?.find((p) => p.playerId === userId);
      teamId = rematchPlayer ? rematchPlayer.teamId : autoAssignTeam(clients, playerCount);
    }

    // ── Register client ─────────────────────────────────────────────────────
    clients.set(userId, { ws, userId, displayName, isGuest, isHost, teamId });

    // ── Cancel any pending host-transfer timer for this room ─────────────────
    // If the ORIGINAL host reconnects before the grace window elapses, cancel
    // the transfer timer.  If a different (non-host) player joins while a timer
    // is running, leave the timer intact — only the original host's reconnect
    // should reset it.
    if (!isMatchmakingRoom) {
      const transferEntry = hostTransferTimers.get(roomCode);
      if (transferEntry && transferEntry.previousHostId === userId) {
        _cancelHostTransferTimer(roomCode);
        console.log(
          `[RoomWS] Original host "${userId}" reconnected — host-disconnect timer cancelled for room "${roomCode}".`,
        );
        // Notify all clients that the host is back.
        broadcast(roomCode, { type: 'host_reconnected', roomCode });
      }
    }

    // ── Confirm connection to the joining client ────────────────────────────
    ws.send(JSON.stringify({ type: 'connected', userId }));

    // ── Broadcast updated player list to ALL clients (players + spectators) ──
    broadcast(roomCode, {
      type:          'room_players',
      players:       getRoomPlayers(roomCode),
      isMatchmaking: isMatchmakingRoom,
    });

    // ── Notify rematch gathering countdown (Sub-AC 45c) ─────────────────────
    // If a 30-second post-rematch gathering countdown is active for this room,
    // notify the game server that this player has rejoined so the countdown
    // state is updated and re-broadcast to all game-socket connections.
    try {
      const gameServer = _getGameServer();
      if (gameServer && typeof gameServer.notifyRematchPlayerJoined === 'function') {
        gameServer.notifyRematchPlayerJoined(roomCode, userId);
      }
    } catch (err) {
      // Non-fatal — gathering timer is best-effort
      console.warn(`[RoomWS] notifyRematchPlayerJoined error for room ${roomCode}:`, err.message);
    }

    // ── Update live games store with current connected player count ──────────
    if (isMatchmakingRoom && liveGamesStore.get(roomCode)) {
      liveGamesStore.updateGame(roomCode, { currentPlayers: clients.size });
    }

    // ── Matchmaking-room auto-start logic ────────────────────────────────────
    // For matchmaking rooms, the game starts automatically:
    //   (a) Immediately when all matched players have connected.
    //   (b) After MATCHMAKING_LOBBY_TIMEOUT_MS (30 s) for late players —
    //       empty seats are filled with bots.
    if (isMatchmakingRoom && !matchmakingTimers.has(roomCode + ':started')) {
      if (clients.size >= playerCount) {
        // All seats filled — cancel any fill timer and start immediately.
        console.log(
          `[RoomWS] Matchmaking room ${roomCode}: all ${playerCount} players joined — auto-starting.`
        );
        const timer = matchmakingTimers.get(roomCode);
        if (timer) { clearTimeout(timer); matchmakingTimers.delete(roomCode); }
        matchmakingTimers.set(roomCode + ':started', true);
        process.nextTick(() => {
          handleAutoStartMatchmaking(roomCode, clients, playerCount).catch((err) => {
            console.error('[RoomWS] Auto-start error for room', roomCode, ':', err);
          });
        });
      } else if (!matchmakingTimers.has(roomCode)) {
        // First player joined — start the 30-second fill timer.
        console.log(
          `[RoomWS] Matchmaking room ${roomCode}: starting ${MATCHMAKING_LOBBY_TIMEOUT_MS / 1000}s fill timer.`
        );
        const handle = setTimeout(() => {
          matchmakingTimers.delete(roomCode);
          if (matchmakingTimers.has(roomCode + ':started')) return;
          matchmakingTimers.set(roomCode + ':started', true);
          handleAutoStartMatchmaking(roomCode, clients, playerCount).catch((err) => {
            console.error('[RoomWS] Auto-start timer error for room', roomCode, ':', err);
          });
        }, MATCHMAKING_LOBBY_TIMEOUT_MS);
        if (handle.unref) handle.unref();
        matchmakingTimers.set(roomCode, handle);
      }
    }

    // ── Sub-AC 45d: Rematch early-start check ────────────────────────────────
    // If a rematch bot-fill timer is pending and ALL original human players
    // have now reconnected, cancel the timer and start the game immediately
    // rather than waiting for the full 30-second window to expire.
    if (_rematchBotFillTimers.has(roomCode)) {
      const rematchPending = getPendingRematch(roomCode);
      if (rematchPending) {
        const humanPlayers   = rematchPending.players.filter((p) => !p.isBot);
        const connectedCount = Array.from(clients.keys()).filter((uid) =>
          humanPlayers.some((hp) => hp.playerId === uid)
        ).length;

        if (humanPlayers.length > 0 && connectedCount >= humanPlayers.length) {
          console.log(
            `[RoomWS] Rematch room ${roomCode}: all ${humanPlayers.length} human(s) reconnected — ` +
            `starting early.`
          );
          cancelRematchBotFillTimer(roomCode);
          // Capture the current clients snapshot for the bot-fill call.
          const earlyClients = clients;
          process.nextTick(() => {
            _executeRematchBotFill(roomCode, earlyClients).catch((err) => {
              console.error(
                '[RoomWS] _executeRematchBotFill (early reconnect) error for room', roomCode, ':', err
              );
            });
          });
        }
      }
    }

    // ── Message handler ─────────────────────────────────────────────────────
    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return; // Ignore malformed JSON
      }

      if (!message || typeof message.type !== 'string') return;

      // Read isHost dynamically so host transfers (which mutate the in-memory
      // entry) are honoured without requiring a reconnect.
      const liveIsHost = clients.get(userId)?.isHost ?? false;

      if (message.type === 'kick_player') {
        // Kick is not allowed in matchmaking rooms (no host).
        if (isMatchmakingRoom) {
          ws.send(JSON.stringify({ type: 'error', message: 'Kick is not allowed in matchmaking rooms' }));
          return;
        }
        handleKickPlayer(
          { ws, userId, displayName, isHost: liveIsHost, roomCode, clients },
          message,
        );
      } else if (message.type === 'change_team') {
        handleChangeTeam({ ws, userId, roomCode, clients }, message);
      } else if (message.type === 'reassign_team') {
        // Host-driven reassignment only allowed in private rooms.
        if (isMatchmakingRoom) {
          ws.send(JSON.stringify({ type: 'error', message: 'Team reassignment is not allowed in matchmaking rooms' }));
          return;
        }
        handleReassignTeam({ ws, userId, isHost: liveIsHost, roomCode, clients }, message);
      } else if (message.type === 'start_game') {
        // Manual start_game only allowed for private room hosts.
        if (isMatchmakingRoom) {
          ws.send(JSON.stringify({ type: 'error', message: 'Matchmaking rooms start automatically' }));
          return;
        }
        handleStartGame({ ws, userId, isHost: liveIsHost, roomCode, clients });
      }
    });

    // ── Disconnect handler ──────────────────────────────────────────────────
    ws.on('close', () => {
      // Capture host status from in-memory entry before deleting it so that the
      // host-transfer timer can be started even if liveIsHost is false at this
      // moment due to a prior transfer.
      const wasHost = clients.get(userId)?.isHost ?? false;

      clients.delete(userId);

      if (clients.size > 0) {
        broadcast(roomCode, {
          type:          'room_players',
          players:       getRoomPlayers(roomCode),
          isMatchmaking: isMatchmakingRoom,
        });

        // If the disconnected player was the host (private room only), start
        // a grace-period timer so that a reconnect within the window cancels
        // the transfer.  Matchmaking rooms have no host concept.
        if (wasHost && !isMatchmakingRoom) {
          _startHostTransferTimer(roomCode, userId);
        }
      } else {
        // Clean up empty entries and any pending timers.
        // Cancel any pending host-transfer timer for this room.
        _cancelHostTransferTimer(roomCode);

        // Only clean up roomMeta if there are also no spectators left, so
        // spectators can still receive messages if the last player disconnects.
        roomClients.delete(roomCode);
        if (!roomSpectators.has(roomCode) || roomSpectators.get(roomCode).size === 0) {
          roomMeta.delete(roomCode);
        }
        const timer = matchmakingTimers.get(roomCode);
        if (timer) { clearTimeout(timer); matchmakingTimers.delete(roomCode); }
        matchmakingTimers.delete(roomCode + ':started');
      }
    });

    ws.on('error', (err) => {
      console.error(
        `[RoomWS] Error for user="${userId}" room="${roomCode}": ${err.message}`,
      );
    });
  });

  return wss;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Clear all in-memory room state (players AND spectators).
 * Used in tests to reset state between cases.
 */
function _resetRoomState() {
  roomClients.clear();
  roomSpectators.clear();
  roomMeta.clear();
  matchmakingTimers.clear();
  // Cancel and clear any pending host-disconnect timers (module-level and local map).
  _clearAllHostDisconnectTimers();
  hostTransferTimers.clear();
  // Cancel and clear any pending rematch bot-fill timers (Sub-AC 45d).
  for (const handle of _rematchBotFillTimers.values()) {
    clearTimeout(handle);
  }
  _rematchBotFillTimers.clear();
  // Reset injected game server so tests get a fresh mock on each require cycle.
  _gameSocketServer = null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  attachRoomSocketServer,

  // Exported for unit testing:
  roomClients,
  roomSpectators,
  roomMeta,
  matchmakingTimers,
  MATCHMAKING_LOBBY_TIMEOUT_MS,
  hostTransferTimers,
  HOST_RECONNECT_WINDOW_MS,
  getRoomPlayers,
  broadcast,
  broadcastToSpectators,
  handleKickPlayer,
  handleChangeTeam,
  handleReassignTeam,
  handleStartGame,
  handleAutoStartMatchmaking,
  buildOccupiedSeats,
  validateStartGame,
  buildSeatsFromClients,
  autoAssignTeam,
  resolveUserFromToken,
  fetchRoomMetaWithToken,
  _setSupabaseClientFactory,
  _setGameServer,
  _startingRooms,
  _resetRoomState,
  // Host transfer helpers (exported for unit testing):
  _startHostTransferTimer,
  _cancelHostTransferTimer,
  _executeHostTransfer,
  // Sub-AC 45d — Rematch bot-fill timer (exported for unit testing and gameSocketServer):
  startRematchBotFillTimer,
  cancelRematchBotFillTimer,
  _executeRematchBotFill,
  _rematchBotFillTimers,
  REMATCH_BOT_FILL_TIMEOUT_MS,
};
