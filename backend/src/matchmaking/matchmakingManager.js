'use strict';

/**
 * Matchmaking manager — handles join-queue / leave-queue WebSocket messages
 * and assembles game lobbies when enough players queue under the same filter.
 *
 * Match assembly flow:
 *   1. Dequeue exactly `playerCount` players from the filter group (FIFO).
 *   2. Create a game room in Supabase; the first dequeued player becomes host.
 *   3. Send { type: 'match-found', roomCode } to every matched player.
 *   4. Broadcast updated queue size to any remaining players in that queue.
 *
 * On Supabase error: matched players are re-queued so they don't lose their spot.
 *
 * WebSocket message protocol:
 *
 *   Client → Server
 *   ───────────────
 *   { type: 'join-queue',  playerCount: 6|8, cardRemovalVariant: string }
 *   { type: 'leave-queue' }
 *
 *   Server → Client (targeted)
 *   ───────────────────────────
 *   { type: 'queue-joined', filterKey, playerCount, cardRemovalVariant, position, queueSize }
 *   { type: 'queue-left',   filterKey }
 *   { type: 'match-found',  roomCode, playerCount, cardRemovalVariant }
 *   { type: 'error',        code, message }
 *
 *   Server → Queue (broadcast)
 *   ──────────────────────────
 *   { type: 'queue-update', filterKey, queueSize }
 */

const { WebSocket } = require('ws');

const {
  makeFilterKey,
  joinQueue,
  leaveQueue,
  getQueuePlayers,
  getQueueSize,
  getPlayerFilterKey,
  dequeueGroup,
} = require('./matchmakingStore');

const { getSupabaseClient } = require('../db/supabase');
const {
  generateUniqueRoomCode,
  generateInviteCode,
  generateSpectatorToken,
} = require('../utils/roomCode');
const liveGamesStore = require('../liveGames/liveGamesStore');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_PLAYER_COUNTS = [6, 8];
const VALID_VARIANTS = ['remove_2s', 'remove_7s', 'remove_8s'];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Send a JSON message to a single WebSocket, suppressing closed-socket errors.
 *
 * @param {WebSocket} ws
 * @param {Object} data
 */
function sendJson(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

/**
 * Broadcast a JSON message to all players currently in the specified queue.
 *
 * @param {string} filterKey
 * @param {Object} data
 */
function broadcastToQueue(filterKey, data) {
  const players = getQueuePlayers(filterKey);
  for (const player of players) {
    sendJson(player.ws, data);
  }
}

// ---------------------------------------------------------------------------
// Handle join-queue message
// ---------------------------------------------------------------------------

/**
 * Process a 'join-queue' WebSocket message.
 *
 * Expected payload:
 *   { type: 'join-queue', playerCount: 6|8, cardRemovalVariant: string }
 *
 * Steps:
 *   1. Validate playerCount and cardRemovalVariant.
 *   2. Add the player to the in-memory queue.
 *   3. Confirm queue entry to the joining player ('queue-joined').
 *   4. Broadcast updated queue size to all players in the group ('queue-update').
 *   5. Try to assemble a match if the queue is now full.
 *
 * @param {WebSocket} ws
 * @param {string}   connectionId
 * @param {{ playerId: string, displayName: string, avatarId: string|null, isGuest: boolean }} user
 * @param {Object}   msg
 */
async function handleJoinQueue(ws, connectionId, user, msg) {
  const { playerCount, cardRemovalVariant } = msg;

  // ── Validate playerCount ────────────────────────────────────────────────────
  const count = Number(playerCount);
  if (!VALID_PLAYER_COUNTS.includes(count)) {
    sendJson(ws, {
      type: 'error',
      code: 'INVALID_PLAYER_COUNT',
      message: `playerCount must be one of: ${VALID_PLAYER_COUNTS.join(', ')}`,
    });
    return;
  }

  // ── Validate cardRemovalVariant ────────────────────────────────────────────
  if (!cardRemovalVariant || !VALID_VARIANTS.includes(cardRemovalVariant)) {
    sendJson(ws, {
      type: 'error',
      code: 'INVALID_VARIANT',
      message: `cardRemovalVariant must be one of: ${VALID_VARIANTS.join(', ')}`,
    });
    return;
  }

  const filterKey = makeFilterKey(count, cardRemovalVariant);

  // ── Add to queue ────────────────────────────────────────────────────────────
  const { position, queueSize } = joinQueue(filterKey, {
    playerId: user.playerId,
    displayName: user.displayName,
    avatarId: user.avatarId ?? null,
    isGuest: user.isGuest,
    connectionId,
    ws,
  });

  // ── Confirm entry to the joining player ────────────────────────────────────
  sendJson(ws, {
    type: 'queue-joined',
    filterKey,
    playerCount: count,
    cardRemovalVariant,
    position,
    queueSize,
  });

  // ── Broadcast updated size to all in this queue (including the new joiner) ─
  broadcastToQueue(filterKey, {
    type: 'queue-update',
    filterKey,
    queueSize,
  });

  // ── Try to assemble a match ─────────────────────────────────────────────────
  await tryAssembleMatch(filterKey, count, cardRemovalVariant);
}

// ---------------------------------------------------------------------------
// Handle leave-queue message
// ---------------------------------------------------------------------------

/**
 * Process a 'leave-queue' WebSocket message.
 *
 * @param {WebSocket} ws
 * @param {string}   connectionId
 * @param {{ playerId: string }} user
 */
function handleLeaveQueue(ws, connectionId, user) {
  const filterKey = getPlayerFilterKey(user.playerId);

  if (!filterKey) {
    sendJson(ws, {
      type: 'error',
      code: 'NOT_IN_QUEUE',
      message: 'You are not in any matchmaking queue',
    });
    return;
  }

  const { removed } = leaveQueue(user.playerId);

  if (removed) {
    sendJson(ws, { type: 'queue-left', filterKey });

    // Broadcast updated size to remaining players
    const newSize = getQueueSize(filterKey);
    broadcastToQueue(filterKey, {
      type: 'queue-update',
      filterKey,
      queueSize: newSize,
    });
  } else {
    sendJson(ws, {
      type: 'error',
      code: 'QUEUE_LEAVE_FAILED',
      message: 'Failed to leave queue',
    });
  }
}

// ---------------------------------------------------------------------------
// Cleanup on disconnect
// ---------------------------------------------------------------------------

/**
 * Remove a player from any matchmaking queue they belong to.
 *
 * Called from the WebSocket 'close' handler so disconnecting players are
 * automatically removed without needing to send 'leave-queue' explicitly.
 *
 * @param {string} playerId
 */
function cleanupQueuedPlayer(playerId) {
  const filterKey = getPlayerFilterKey(playerId);
  if (!filterKey) return; // not in any queue

  const { removed } = leaveQueue(playerId);
  if (removed) {
    const newSize = getQueueSize(filterKey);
    broadcastToQueue(filterKey, {
      type: 'queue-update',
      filterKey,
      queueSize: newSize,
    });
  }
}

// ---------------------------------------------------------------------------
// Match assembly
// ---------------------------------------------------------------------------

/**
 * Check if the filter group has enough players for a match, and if so,
 * dequeue them, create a Supabase room, and notify all matched players.
 *
 * This function is intentionally idempotent: concurrent calls are safe because
 * dequeueGroup() is atomic (it either dequeues the full group or returns null).
 *
 * @param {string} filterKey
 * @param {number} requiredCount - playerCount (6 or 8)
 * @param {string} cardRemovalVariant
 */
async function tryAssembleMatch(filterKey, requiredCount, cardRemovalVariant) {
  const currentSize = getQueueSize(filterKey);
  if (currentSize < requiredCount) {
    return; // not enough players yet — wait for more
  }

  // Atomically dequeue exactly requiredCount players (FIFO by joinedAt)
  const matchedPlayers = dequeueGroup(filterKey, requiredCount);
  if (!matchedPlayers || matchedPlayers.length < requiredCount) {
    // Race-condition guard: another concurrent tryAssembleMatch already matched them
    return;
  }

  try {
    const supabase = getSupabaseClient();

    // Prefer a registered user as host (guests don't exist in auth.users).
    // Fall back to null if all players are guests.
    const registeredHost = matchedPlayers.find((p) => !p.isGuest);
    const hostUserId = registeredHost ? registeredHost.playerId : null;

    const roomCode = await generateUniqueRoomCode(supabase);
    const inviteCode = generateInviteCode();
    const spectatorToken = generateSpectatorToken();

    const { data: room, error } = await supabase
      .from('rooms')
      .insert({
        code: roomCode,
        invite_code: inviteCode,
        spectator_token: spectatorToken,
        host_user_id: hostUserId,
        player_count: requiredCount,
        card_removal_variant: cardRemovalVariant,
        status: 'waiting',
        // Mark as a matchmaking room: no host controls, auto-start when full.
        is_matchmaking: true,
      })
      .select()
      .single();

    if (error || !room) {
      console.error('[matchmaking] Failed to create room for matched players:', error);
      // Re-queue matched players so they don't lose their spot
      for (const player of matchedPlayers) {
        joinQueue(filterKey, player);
      }
      return;
    }

    console.log(
      `[matchmaking] Match assembled: ${requiredCount} players → room ${room.code} ` +
        `(variant: ${cardRemovalVariant})`
    );

    // ── Register the new room in the live games store ───────────────────────
    // All matched players are already assigned so currentPlayers = requiredCount
    // (they may not have connected to the room WS yet, but the match is locked).
    liveGamesStore.addGame({
      roomCode:       room.code,
      playerCount:    requiredCount,
      currentPlayers: matchedPlayers.length,
      cardVariant:    cardRemovalVariant,
      spectatorUrl:   `/game/${room.code}?spectatorToken=${encodeURIComponent(room.spectator_token)}`,
      scores:         { team1: 0, team2: 0 },
      status:         'waiting',
      createdAt:      Date.now(),
      startedAt:      null,
    });

    // Notify each matched player of the new room.
    // `isMatchmaking: true` lets the frontend skip host controls in the lobby.
    for (const player of matchedPlayers) {
      sendJson(player.ws, {
        type: 'match-found',
        roomCode: room.code,
        playerCount: requiredCount,
        cardRemovalVariant,
        isMatchmaking: true,
      });
    }

    // Broadcast updated (smaller) queue size to any remaining players
    const remaining = getQueueSize(filterKey);
    broadcastToQueue(filterKey, {
      type: 'queue-update',
      filterKey,
      queueSize: remaining,
    });
  } catch (err) {
    console.error('[matchmaking] Unexpected error assembling match:', err);
    // Re-queue on unexpected error so players aren't silently lost
    if (matchedPlayers) {
      for (const player of matchedPlayers) {
        joinQueue(filterKey, player);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Message handlers (called from wsServer.js)
  handleJoinQueue,
  handleLeaveQueue,
  cleanupQueuedPlayer,

  // Match assembly (exported for testing)
  tryAssembleMatch,

  // Constants (re-exported for route validation)
  VALID_PLAYER_COUNTS,
  VALID_VARIANTS,

  // Internal helpers (exported for tests)
  broadcastToQueue,
  sendJson,
};
