'use strict';

/**
 * Game state factory and serialisation helpers.
 *
 * A GameState object is the single source of truth for a live game.
 * It lives in the in-memory gameStore (Map<roomCode, GameState>)
 * and is periodically persisted to Supabase for crash recovery.
 *
 * Shape:
 * {
 * roomCode: string,
 * roomId: string, // Supabase room UUID
 * variant: 'remove_2s'|'remove_7s'|'remove_8s',
 * playerCount: 6|8,
 * status: 'active'|'completed',
 * currentTurnPlayerId:string,
 * players: Player[],
 * hands: Map<playerId, Set<cardId>>,
 * declaredSuits: Map<halfSuitId, { teamId:1|2, declaredBy:string }>,
 * scores: { team1: number, team2: number },
 * lastMove: string|null,
 * winner: 1|2|null,
 * tiebreakerWinner: 1|2|null,
 * // Bot inference: not broadcast to clients
 * botKnowledge: Map<playerId, Map<cardId, boolean>>,
 * teamIntentMemory: Map<teamId, Map<halfSuitId, {
 *   strength:number, lastUpdatedMoveIndex:number, sourcePlayerId:string,
 *   focusCardId:string, lastOutcome:string
 * }>>,
 * // Call history for crash recovery
 * moveHistory: MoveRecord[],
 * }
 *
 * Note: partial-selection state (current wizard step for ask/declare) is
 * maintained in a SEPARATE store (partialSelectionStore.js) keyed by
 * `roomCode:playerId`. It is NOT part of the GameState object itself so
 * it never leaks into the Supabase snapshot or affects crash recovery.
 *
 * Player shape:
 * {
 * playerId: string,
 * displayName: string,
 * avatarId: string|null,
 * teamId: 1|2,
 * seatIndex: number,
 * isBot: boolean,
 * isGuest: boolean,
 * }
 */

const { buildDeck, shuffleDeck, dealCards, cardLabel } = require('./deck');
const { buildCardToHalfSuitMap, halfSuitLabel } = require('./halfSuits');

/**
 * Create a brand-new game state from a lobby seat snapshot.
 *
 * @param {{
 * roomCode: string,
 * roomId: string,
 * variant: 'remove_2s'|'remove_7s'|'remove_8s',
 * playerCount: 6|8,
 * seats: Array<{
 * seatIndex: number,
 * playerId: string,
 * displayName: string,
 * avatarId: string|null,
 * teamId: 1|2,
 * isBot: boolean,
 * isGuest: boolean,
 * }>,
 * }} options
 * @returns {Object} A fresh GameState
 */
function createGameState({ roomCode, roomId, variant, playerCount, seats }) {
  // Sort seats by seatIndex to get a consistent player order.
  const sortedSeats = [...seats].sort((a, b) => a.seatIndex - b.seatIndex);

  // Build and deal the deck.
  const deck   = shuffleDeck(buildDeck(variant));
  const dealt  = dealCards(deck, playerCount);

  // Build the hands Map.
  /** @type {Map<string, Set<string>>} */
  const hands = new Map();
  for (let i = 0; i < sortedSeats.length; i++) {
    hands.set(sortedSeats[i].playerId, new Set(dealt[i]));
  }

  // The first turn goes to the player in seat 0.
  const firstTurnPlayerId = sortedSeats[0].playerId;

  return {
    roomCode,
    roomId,
    variant,
    playerCount,
    status: 'active',
    currentTurnPlayerId: firstTurnPlayerId,

    // Immutable player list (ordered by seatIndex).
    players: sortedSeats.map((s) => ({
      playerId:    s.playerId,
      displayName: s.displayName,
      avatarId:    s.avatarId ?? null,
      teamId:      s.teamId,
      seatIndex:   s.seatIndex,
      isBot:       s.isBot,
      isGuest:     s.isGuest,
    })),

    hands,

    // Declared half-suits: halfSuitId → { teamId, declaredBy }
    /** @type {Map<string, { teamId: 1|2, declaredBy: string }>} */
    declaredSuits: new Map(),

    scores: { team1: 0, team2: 0 },
    lastMove: null,
    winner: null,
    tiebreakerWinner: null,

    // Bot inference state (not broadcast to clients)
    /** @type {Map<string, Map<string, boolean|null>>} */
    botKnowledge: new Map(),

    // Lightweight team signaling memory used by bots to coordinate asks.
    // Private server-side state: never broadcast, but persisted for recovery.
    /** @type {Map<1|2, Map<string, { strength:number, lastUpdatedMoveIndex:number, sourcePlayerId:string, focusCardId:string, lastOutcome:string }>>} */
    teamIntentMemory: new Map(),

    // Move history for crash recovery
    moveHistory: [],

    // ── Player elimination ─────────────────────────────────────
    // Set of playerIds whose hands are now empty (cards removed by a declaration).
    // Populated by applyDeclaration / applyForcedFailedDeclaration when a
    // player's card count drops to zero.
    /** @type {Set<string>} */
    eliminatedPlayerIds: new Set(),

    // Optional turn-recipient map: when an eliminated player (human or bot)
    // designates a teammate to receive their future turns, the choice is stored
    // here. _resolveValidTurn consults this map before falling back to seat order.
    /** @type {Map<string, string>} */
    turnRecipients: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Return all players on a given team.
 * @param {Object} gs - GameState
 * @param {1|2} teamId
 * @returns {Array}
 */
function getTeamPlayers(gs, teamId) {
  return gs.players.filter((p) => p.teamId === teamId);
}

/**
 * Return the team ID for a given player.
 * @param {Object} gs
 * @param {string} playerId
 * @returns {1|2|null}
 */
function getPlayerTeam(gs, playerId) {
  const p = gs.players.find((pl) => pl.playerId === playerId);
  return p ? p.teamId : null;
}

/**
 * Return the hand (Set<cardId>) for a player.
 * @param {Object} gs
 * @param {string} playerId
 * @returns {Set<string>}
 */
function getHand(gs, playerId) {
  return gs.hands.get(playerId) ?? new Set();
}

/**
 * Return the number of cards a player holds.
 * @param {Object} gs
 * @param {string} playerId
 * @returns {number}
 */
function getCardCount(gs, playerId) {
  return getHand(gs, playerId).size;
}

/**
 * Return the half-suit ID for a card given the game's variant.
 * Uses the shared card-to-half-suit map.
 * @param {Object} gs
 * @param {string} card
 * @returns {string}
 */
function cardHalfSuit(gs, card) {
  const map = buildCardToHalfSuitMap(gs.variant);
  return map.get(card);
}

/**
 * Return true if a half-suit has already been declared.
 * @param {Object} gs
 * @param {string} halfSuitId
 * @returns {boolean}
 */
function isHalfSuitDeclared(gs, halfSuitId) {
  return gs.declaredSuits.has(halfSuitId);
}

// ---------------------------------------------------------------------------
// Wire-safe serialization (sent to clients)
// ---------------------------------------------------------------------------

/**
 * Build the public game-state snapshot sent to ALL clients.
 * Does NOT include any player's hand.
 *
 * @param {Object} gs - GameState
 * @returns {Object}
 */
function serializePublicState(gs) {
  // Declared suits as plain object array
  const declaredSuitsArr = Array.from(gs.declaredSuits.entries()).map(
    ([halfSuitId, info]) => ({ halfSuitId, teamId: info.teamId, declaredBy: info.declaredBy })
  );

  return {
    status:              gs.status,
    currentTurnPlayerId: gs.currentTurnPlayerId,
    scores:              { ...gs.scores },
    lastMove:            gs.lastMove,
    winner:              gs.winner,
    tiebreakerWinner:    gs.tiebreakerWinner,
    declaredSuits:       declaredSuitsArr,
  };
}

/**
 * Build the player list with card counts (not actual cards) for broadcast.
 *
 * Each player entry includes:
 * - cardCount: total cards held
 *
 * @param {Object} gs
 * @returns {Array}
 */
function serializePlayers(gs) {
  return gs.players.map((p) => {
    const hand = getHand(gs, p.playerId);

    return {
      playerId:      p.playerId,
      displayName:   p.displayName,
      avatarId:      p.avatarId,
      teamId:        p.teamId,
      seatIndex:     p.seatIndex,
      isBot:         p.isBot,
      isGuest:       p.isGuest,
      cardCount:     hand.size,
      isCurrentTurn: p.playerId === gs.currentTurnPlayerId,
      // true when this player has no cards left (hand emptied by declaration)
      isEliminated:  gs.eliminatedPlayerIds ? gs.eliminatedPlayerIds.has(p.playerId) : false,
    };
  });
}

/**
 * Build a personalized game-init message for a specific player.
 * Includes their full hand but not other players' cards.
 *
 * @param {Object} gs
 * @param {string} playerId
 * @returns {Object}
 */
function serializeForPlayer(gs, playerId) {
  const hand = Array.from(getHand(gs, playerId));

  return {
    type:        'game_init',
    roomCode:    gs.roomCode,
    variant:     gs.variant,
    playerCount: gs.playerCount,
    myPlayerId:  playerId,
    myHand:      hand,
    players:     serializePlayers(gs),
    gameState:   serializePublicState(gs),
  };
}

/**
 * Build the full hand map for God-mode spectators.
 *
 * Unlike `serializePlayers()`, this includes every player's exact cards and is
 * intended ONLY for spectator-targeted payloads (`spectator_init`,
 * `spectator_hands`). Never include this in shared player broadcasts.
 *
 * @param {Object} gs
 * @returns {Record<string, string[]>}
 */
function serializeSpectatorHands(gs) {
  return Object.fromEntries(
    gs.players.map((player) => [
      player.playerId,
      Array.from(getHand(gs, player.playerId)),
    ])
  );
}

/**
 * Build a spectator-facing move log with preformatted messages.
 *
 * Uses the authoritative server move history but converts records into the
 * same human-friendly strings spectators already see in `lastMove`.
 *
 * @param {Object} gs
 * @returns {Array<{ type: string, ts: number, message: string }>}
 */
function serializeSpectatorMoveHistory(gs) {
  const playerName = (playerId) => {
    const player = gs.players.find((entry) => entry.playerId === playerId);
    return player?.displayName ?? 'Unknown player';
  };

  return (gs.moveHistory ?? []).map((move) => {
    if (move.type === 'ask') {
      return {
        type: move.type,
        ts: move.ts,
        message: `${playerName(move.askerId)} asked ${playerName(move.targetId)} for ${cardLabel(move.cardId)} — ${move.success ? 'got it' : 'denied'}`,
      };
    }

    if (move.type === 'declaration') {
      const teamScore = `Team ${move.winningTeam} scores`;
      const suitName = halfSuitLabel(move.halfSuitId);

      return {
        type: move.type,
        ts: move.ts,
        message: move.timedOut
          ? `${playerName(move.declarerId)} ran out of time declaring ${suitName} — ${teamScore}`
          : `${playerName(move.declarerId)} declared ${suitName} — ${move.correct ? 'correct!' : 'incorrect!'} ${teamScore}`,
      };
    }

    return {
      type: move.type ?? 'unknown',
      ts: move.ts ?? Date.now(),
      message: 'Unknown move',
    };
  });
}

/**
 * Build the JSON-safe snapshot stored in rooms.game_state.
 *
 * @param {Object} gs - GameState
 * @returns {Object}
 */
function buildPersistedSnapshot(gs) {
  return {
    variant:             gs.variant,
    playerCount:         gs.playerCount,
    status:              gs.status,
    currentTurnPlayerId: gs.currentTurnPlayerId,
    players:             gs.players,
    hands:               Object.fromEntries(
      Array.from(gs.hands.entries()).map(([pid, set]) => [pid, Array.from(set)])
    ),
    declaredSuits: Object.fromEntries(
      Array.from(gs.declaredSuits.entries())
    ),
    scores:         gs.scores,
    lastMove:       gs.lastMove,
    winner:         gs.winner,
    tiebreakerWinner: gs.tiebreakerWinner,
    moveHistory:    gs.moveHistory,
    teamIntentMemory: Object.fromEntries(
      Array.from(gs.teamIntentMemory ?? new Map()).map(([teamId, suitMap]) => [
        String(teamId),
        Object.fromEntries(Array.from(suitMap ?? new Map())),
      ])
    ),
    // persist eliminated player IDs and turn recipients
    eliminatedPlayerIds: Array.from(gs.eliminatedPlayerIds ?? []),
    turnRecipients:      Object.fromEntries(gs.turnRecipients ?? new Map()),
  };
}

/**
 * Persist the game state snapshot to Supabase.
 * Called after every move to enable crash recovery.
 * Non-fatal: if it fails we log and continue.
 *
 * @param {Object} gs - GameState
 * @param {Object} supabase - Supabase client
 * @returns {Promise<void>}
 */
async function persistGameState(gs, supabase) {
  const snapshot = buildPersistedSnapshot(gs);
  const roomStatus = gs.status === 'completed'
    ? 'completed'
    : gs.status === 'abandoned'
    ? 'abandoned'
    : 'in_progress';

  try {
    await supabase
      .from('rooms')
      .update({ game_state: snapshot, status: roomStatus })
      .eq('code', gs.roomCode);
  } catch (err) {
    console.error('[gameState] Failed to persist game state for room', gs.roomCode, ':', err);
  }
}

/**
 * Mark a room as abandoned in Supabase.
 *
 * Called when an in-progress game is cleaned up without ever completing (e.g.
 * all players disconnected and the reconnect window expired with no activity,
 * or the game was explicitly dissolved before all 8 half-suits were declared).
 *
 * IMPORTANT: stats are NEVER written for abandoned games — updateStats() in
 * gameSocketServer.js guards `gs.status !== 'completed'` before touching the
 * user_stats table, and this function is only called when the game is NOT
 * completing normally.
 *
 * Non-fatal: failures are logged but do not propagate.
 *
 * @param {string} roomCode
 * @param {Object} supabase - Supabase client (service-role)
 * @param {Object|null} [snapshotSource=null] - Optional GameState to persist as
 * the final abandoned snapshot so recovery cannot resurrect an old active game.
 * @returns {Promise<void>}
 */
async function markRoomAbandoned(roomCode, supabase, snapshotSource = null) {
  const updatePayload = { status: 'abandoned' };
  if (snapshotSource) {
    updatePayload.game_state = buildPersistedSnapshot(snapshotSource);
  }

  try {
    const { error } = await supabase
      .from('rooms')
      .update(updatePayload)
      .eq('code', roomCode)
      .in('status', ['in_progress', 'starting', 'waiting']);

    if (error) {
      console.warn(
        `[gameState] markRoomAbandoned: failed to update room ${roomCode}:`,
        error.message
      );
    } else {
      console.log(`[gameState] Room ${roomCode} marked as abandoned`);
    }
  } catch (err) {
    console.error('[gameState] markRoomAbandoned error:', err);
  }
}

/**
 * Sweep all stale 'in_progress' rooms in Supabase and mark them 'abandoned'.
 *
 * Intended to be called once at server startup so rooms that were left in
 * 'in_progress' by a previous server instance (crash / graceful restart) are
 * correctly classified. Only rooms whose updated_at is older than
 * `staleAfterMs` are touched — this preserves any room that was updated
 * very recently and whose players might still be reconnecting.
 *
 * Uses the mark_stale_games_abandoned() Postgres function added by migration
 * 009 so the sweep is a single round-trip to the DB.
 *
 * @param {Object} supabase - Supabase client (service-role)
 * @param {number} [staleAfterMs=7200000] - Rooms idle longer than this are
 * considered abandoned (default: 2 hours)
 * @returns {Promise<void>}
 */
async function markStaleGamesAbandoned(supabase, staleAfterMs = 2 * 60 * 60 * 1000) {
  try {
    // Convert ms to a Postgres interval string (e.g. '7200 seconds')
    const staleAfterSeconds = Math.floor(staleAfterMs / 1000);
    const { data, error } = await supabase
      .rpc('mark_stale_games_abandoned', {
        stale_after: `${staleAfterSeconds} seconds`,
      });

    if (error) {
      console.warn('[gameState] markStaleGamesAbandoned RPC error:', error.message);
    } else {
      const count = typeof data === 'number' ? data : 0;
      if (count > 0) {
        console.log(`[gameState] Startup cleanup: marked ${count} stale in_progress room(s) as abandoned`);
      }
    }
  } catch (err) {
    console.error('[gameState] markStaleGamesAbandoned error:', err);
  }
}

/**
 * Restore a game state from a Supabase snapshot.
 * Called on server restart / crash recovery.
 *
 * @param {Object} snapshot - Raw JSON from Supabase game_state column
 * @param {string} roomCode
 * @param {string} roomId
 * @returns {Object} Restored GameState
 */
function restoreGameState(snapshot, roomCode, roomId) {
  const gs = {
    roomCode,
    roomId,
    variant:             snapshot.variant,
    playerCount:         snapshot.playerCount,
    status:              snapshot.status,
    currentTurnPlayerId: snapshot.currentTurnPlayerId,
    players:             snapshot.players,
    hands:               new Map(
      Object.entries(snapshot.hands).map(([pid, cards]) => [pid, new Set(cards)])
    ),
    declaredSuits: new Map(Object.entries(snapshot.declaredSuits)),
    scores:        snapshot.scores,
    lastMove:      snapshot.lastMove,
    winner:        snapshot.winner,
    tiebreakerWinner: snapshot.tiebreakerWinner,
    botKnowledge:  new Map(),
    teamIntentMemory: new Map(
      Object.entries(snapshot.teamIntentMemory ?? {}).map(([teamId, suitMap]) => [
        Number(teamId),
        new Map(Object.entries(suitMap ?? {})),
      ])
    ),
    moveHistory:   snapshot.moveHistory ?? [],
    // restore elimination state
    eliminatedPlayerIds: new Set(snapshot.eliminatedPlayerIds ?? []),
    turnRecipients:      new Map(Object.entries(snapshot.turnRecipients ?? {})),
  };
  return gs;
}

module.exports = {
  createGameState,
  getTeamPlayers,
  getPlayerTeam,
  getHand,
  getCardCount,
  cardHalfSuit,
  isHalfSuitDeclared,
  serializePublicState,
  serializePlayers,
  serializeForPlayer,
  serializeSpectatorHands,
  serializeSpectatorMoveHistory,
  buildPersistedSnapshot,
  persistGameState,
  restoreGameState,
  // AC 52: abandoned-game cleanup
  markRoomAbandoned,
  markStaleGamesAbandoned,
};
