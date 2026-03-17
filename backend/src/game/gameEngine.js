'use strict';

/**
 * Game engine — pure rule enforcement for the Literature card game.
 *
 * All functions are PURE given a GameState object: they return
 * { success, error?, ...updates } without mutating state.
 * The callers (gameSocketServer) apply mutations after validation.
 *
 * Rules reference:
 * - Ask eligibility: asker must hold ≥1 card in the target half-suit;
 * target must be an opponent with ≥1 card total AND ≥1 card in the
 * requested half-suit; asker must not hold the requested card;
 * card must not already be in a declared suit.
 * - Declaration: only the current-turn player may declare; all 6 cards of
 * the half-suit must be assigned to teammates; correctness checked card-by-card.
 * - Turn pass: ask failure → turn to target; ask success → keep turn.
 * After declaration: declarer keeps turn if they still have cards,
 * otherwise passes to next teammate with cards (or any remaining player).
 * - Game end: all 8 half-suits declared; tiebreaker = team that declared high_d.
 */

const { buildHalfSuitMap, buildCardToHalfSuitMap, TIEBREAKER_HALF_SUIT, allHalfSuitIds, halfSuitLabel } = require('./halfSuits');
const { cardLabel } = require('./deck');
const {
  getHand,
  getCardCount,
  getHalfSuitCardCount,
  getPlayerTeam,
  getTeamPlayers,
  cardHalfSuit,
  isHalfSuitDeclared,
} = require('./gameState');

// ---------------------------------------------------------------------------
// Ask card
// ---------------------------------------------------------------------------

/**
 * Validate an ask-card action.
 *
 * @param {Object} gs - Current GameState
 * @param {string} askerId - Player making the request
 * @param {string} targetId - Player being asked
 * @param {string} cardId - Card being requested
 * @returns {{ valid: boolean, error?: string, errorCode?: string }}
 */
function validateAsk(gs, askerId, targetId, cardId) {
  // 1. Game must be active
  if (gs.status !== 'active') {
    return { valid: false, error: 'Game is not active', errorCode: 'GAME_NOT_ACTIVE' };
  }

  // 2. It must be the asker's turn
  if (gs.currentTurnPlayerId !== askerId) {
    return { valid: false, error: 'It is not your turn', errorCode: 'NOT_YOUR_TURN' };
  }

  // 3. asker must exist
  const askerTeam = getPlayerTeam(gs, askerId);
  if (!askerTeam) {
    return { valid: false, error: 'Asker not found', errorCode: 'PLAYER_NOT_FOUND' };
  }

  // 4. target must exist
  const targetTeam = getPlayerTeam(gs, targetId);
  if (!targetTeam) {
    return { valid: false, error: 'Target player not found', errorCode: 'PLAYER_NOT_FOUND' };
  }

  // 5. Cannot ask a teammate
  if (askerTeam === targetTeam) {
    return { valid: false, error: 'Can only ask cards from opponents', errorCode: 'SAME_TEAM' };
  }

  // 6. Cannot ask yourself
  if (askerId === targetId) {
    return { valid: false, error: 'Cannot ask yourself', errorCode: 'SELF_ASK' };
  }

  // 7. Target must have at least 1 card
  if (getCardCount(gs, targetId) === 0) {
    return { valid: false, error: 'Target player has no cards', errorCode: 'TARGET_EMPTY' };
  }

  // 8. Card must still exist in the game (not in a declared suit)
  const halfSuitId = cardHalfSuit(gs, cardId);
  if (!halfSuitId) {
    return { valid: false, error: 'Invalid card', errorCode: 'INVALID_CARD' };
  }
  if (isHalfSuitDeclared(gs, halfSuitId)) {
    return { valid: false, error: 'That half-suit has already been declared', errorCode: 'SUIT_DECLARED' };
  }

  // 9. Asker must NOT already hold the requested card
  const askerHand = getHand(gs, askerId);
  if (askerHand.has(cardId)) {
    return { valid: false, error: 'You already hold that card', errorCode: 'ALREADY_HELD' };
  }

  // 10. Asker must hold ≥1 card in the same half-suit as the requested card
  const halfSuitCards = buildHalfSuitMap(gs.variant).get(halfSuitId) ?? [];
  const askerHasHalfSuitCard = halfSuitCards.some(
    (c) => c !== cardId && askerHand.has(c)
  );
  if (!askerHasHalfSuitCard) {
    return {
      valid: false,
      error: `You must hold at least one card in ${halfSuitLabel(halfSuitId)} to ask for that card`,
      errorCode: 'NO_HALF_SUIT_CARD',
    };
  }

  return { valid: true };
}

/**
 * Apply a successful ask (card transfer) to the game state.
 * Returns the mutations to apply; caller must apply them.
 *
 * @param {Object} gs
 * @param {string} askerId
 * @param {string} targetId
 * @param {string} cardId
 * @returns {{ success: boolean, newTurnPlayerId: string, lastMove: string }}
 */
function applyAsk(gs, askerId, targetId, cardId) {
  const targetHand = getHand(gs, targetId);
  const askerHand  = getHand(gs, askerId);

  const success = targetHand.has(cardId);

  if (success) {
    // Transfer card from target to asker
    targetHand.delete(cardId);
    askerHand.add(cardId);
    gs.lastMove = `${_playerName(gs, askerId)} asked ${_playerName(gs, targetId)} for ${cardLabel(cardId)} — got it`;
    gs.currentTurnPlayerId = askerId; // keep turn on success
  } else {
    gs.lastMove = `${_playerName(gs, askerId)} asked ${_playerName(gs, targetId)} for ${cardLabel(cardId)} — denied`;
    gs.currentTurnPlayerId = targetId; // pass turn on failure
  }

  // Record the move
  gs.moveHistory.push({
    type: 'ask',
    askerId,
    targetId,
    cardId,
    success,
    ts: Date.now(),
  });

  // If the new turn-holder has no cards, find them a valid turn-passer.
  gs.currentTurnPlayerId = _resolveValidTurn(gs, gs.currentTurnPlayerId);

  return { success, newTurnPlayerId: gs.currentTurnPlayerId, lastMove: gs.lastMove };
}

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

/**
 * Return the set of cards from `halfSuitId` that are currently held by
 * `declarerId`. These cards are "locked" — the declarant knows exactly which
 * cards they hold, so the assignment must assign each of them back to the
 * declarant. Prevents a player from re-attributing their own cards to a
 * teammate (intentionally or via a client bug).
 *
 * @param {Object} gs
 * @param {string} declarerId
 * @param {string} halfSuitId
 * @returns {Set<string>} set of locked cardIds
 */
function getDeclarantLockedCards(gs, declarerId, halfSuitId) {
  const halfSuitCards = buildHalfSuitMap(gs.variant).get(halfSuitId);
  if (!halfSuitCards) return new Set();
  const declarerHand = gs.hands.get(declarerId) ?? new Set();
  const locked = new Set();
  for (const card of halfSuitCards) {
    if (declarerHand.has(card)) {
      locked.add(card);
    }
  }
  return locked;
}

/**
 * Validate a declaration attempt.
 *
 * @param {Object} gs
 * @param {string} declarerId
 * @param {string} halfSuitId
 * @param {Object.<string, string>} assignment - { cardId: playerId }
 * @returns {{ valid: boolean, error?: string, errorCode?: string }}
 */
function validateDeclaration(gs, declarerId, halfSuitId, assignment) {
  // 1. Game must be active
  if (gs.status !== 'active') {
    return { valid: false, error: 'Game is not active', errorCode: 'GAME_NOT_ACTIVE' };
  }

  // 2. Must be the declarer's turn
  if (gs.currentTurnPlayerId !== declarerId) {
    return { valid: false, error: 'It is not your turn', errorCode: 'NOT_YOUR_TURN' };
  }

  // 3. Half-suit must not already be declared
  if (isHalfSuitDeclared(gs, halfSuitId)) {
    return { valid: false, error: 'That half-suit has already been declared', errorCode: 'ALREADY_DECLARED' };
  }

  // 4. Half-suit must be valid
  const halfSuitCards = buildHalfSuitMap(gs.variant).get(halfSuitId);
  if (!halfSuitCards) {
    return { valid: false, error: 'Invalid half-suit ID', errorCode: 'INVALID_HALF_SUIT' };
  }

  // 4a. Declarer must hold at least 1 card from the half-suit
  const declarerHand = gs.hands.get(declarerId) ?? new Set();
  const hasCardInSuit = halfSuitCards.some((card) => declarerHand.has(card));
  if (!hasCardInSuit) {
    return {
      valid: false,
      error: 'You must hold at least one card from the half-suit to declare it',
      errorCode: 'DECLARANT_HAS_NO_CARDS',
    };
  }

  // 5. Assignment must cover all 6 cards
  const assignedCards = Object.keys(assignment);
  if (assignedCards.length !== 6) {
    return {
      valid: false,
      error: `Declaration must assign all 6 cards (got ${assignedCards.length})`,
      errorCode: 'INCOMPLETE_ASSIGNMENT',
    };
  }
  const missingCards = halfSuitCards.filter((c) => !(c in assignment));
  if (missingCards.length > 0) {
    return {
      valid: false,
      error: `Declaration is missing cards: ${missingCards.map(cardLabel).join(', ')}`,
      errorCode: 'MISSING_CARDS',
    };
  }

  // 5b. Locked-card check: declarant's own cards MUST be assigned to themselves.
  // Cards the declarant physically holds are "locked" — they are known facts
  // and cannot be reassigned to a teammate during the declaration flow.
  const lockedCards = getDeclarantLockedCards(gs, declarerId, halfSuitId);
  for (const lockedCard of lockedCards) {
    if (assignment[lockedCard] !== declarerId) {
      return {
        valid: false,
        error: `Card ${cardLabel(lockedCard)} is in your hand and must be assigned to yourself`,
        errorCode: 'LOCKED_CARD_REASSIGNED',
        lockedCard,
      };
    }
  }

  // 6. All assigned players must be on the declarer's team
  const declarerTeam = getPlayerTeam(gs, declarerId);
  for (const [, assignedPlayerId] of Object.entries(assignment)) {
    const assigneeTeam = getPlayerTeam(gs, assignedPlayerId);
    if (!assigneeTeam) {
      return { valid: false, error: `Assigned player ${assignedPlayerId} not found`, errorCode: 'PLAYER_NOT_FOUND' };
    }
    if (assigneeTeam !== declarerTeam) {
      return { valid: false, error: 'Cannot assign cards to opponents', errorCode: 'CROSS_TEAM_ASSIGN' };
    }
  }

  return { valid: true };
}

/**
 * Apply a declaration to the game state.
 * Returns the result and mutations; caller applies them.
 *
 * @param {Object} gs
 * @param {string} declarerId
 * @param {string} halfSuitId
 * @param {Object.<string, string>} assignment - { cardId: playerId }
 * @returns {{
 * correct: boolean,
 * winningTeam: 1|2,
 * newTurnPlayerId: string,
 * lastMove: string,
 * actualHolders: Object.<string, string>,
 * wrongAssignmentDiffs: Array<{ card: string, claimedPlayerId: string, actualPlayerId: string|null }>
 * }}
 */
function applyDeclaration(gs, declarerId, halfSuitId, assignment) {
  const halfSuitCards = buildHalfSuitMap(gs.variant).get(halfSuitId);
  const declarerTeam  = getPlayerTeam(gs, declarerId);

  // Capture actual card holders BEFORE cards are removed from hands.
  // Also compute wrong-assignment diffs for failed declarations.
  const actualHolders = {};
  let correct = true;
  const wrongAssignmentDiffs = [];
  for (const card of halfSuitCards) {
    const assignedPlayerId = assignment[card];
    const actualPlayerId   = _findCardHolder(gs, card);
    actualHolders[card]    = actualPlayerId;
    if (actualPlayerId !== assignedPlayerId) {
      correct = false;
      wrongAssignmentDiffs.push({ card, claimedPlayerId: assignedPlayerId, actualPlayerId });
    }
  }

  const winningTeam = correct ? declarerTeam : (declarerTeam === 1 ? 2 : 1);

  // Update scores
  if (winningTeam === 1) gs.scores.team1++;
  else gs.scores.team2++;

  // Remove all 6 half-suit cards from all hands
  for (const card of halfSuitCards) {
    for (const [, hand] of gs.hands) {
      hand.delete(card);
    }
  }

  // detect players whose hands are now empty for the first time
  const newlyEliminated = _detectNewlyEliminated(gs);

  // Mark as declared
  gs.declaredSuits.set(halfSuitId, { teamId: winningTeam, declaredBy: declarerId });

  // Build last-move string
  const suitName = halfSuitLabel(halfSuitId);
  if (correct) {
    gs.lastMove = `${_playerName(gs, declarerId)} declared ${suitName} — correct! Team ${winningTeam} scores`;
  } else {
    gs.lastMove = `${_playerName(gs, declarerId)} declared ${suitName} — incorrect! Team ${winningTeam} scores`;
  }

  // Record move
  gs.moveHistory.push({
    type: 'declaration',
    declarerId,
    halfSuitId,
    assignment,
    correct,
    winningTeam,
    ts: Date.now(),
  });

  // Update tiebreaker tracking
  if (halfSuitId === TIEBREAKER_HALF_SUIT) {
    gs.tiebreakerWinner = winningTeam;
  }

  // AC 29: on a failed declaration, pass turn clockwise to the next eligible opponent.
  // On a correct declaration, the declaring team keeps the turn.
  if (correct) {
    gs.currentTurnPlayerId = _resolveValidTurn(gs, declarerId);
  } else {
    gs.currentTurnPlayerId = _nextClockwiseOpponent(gs, declarerId, winningTeam);
  }

  // Check if game is over
  if (gs.declaredSuits.size === 8) {
    _endGame(gs);
  }

  return {
    correct,
    winningTeam,
    newTurnPlayerId: gs.currentTurnPlayerId,
    lastMove: gs.lastMove,
    actualHolders,
    wrongAssignmentDiffs,
    newlyEliminated,
  };
}

// ---------------------------------------------------------------------------
// Forced-failed declaration (AC 24)
// ---------------------------------------------------------------------------

/**
 * Apply a forced-failed declaration when the turn timer expires while a
 * connected human player has an incomplete card assignment (AC 24).
 *
 * Unlike `applyDeclaration`, this does NOT require a complete assignment.
 * The opposing team is unconditionally awarded the point, all 6 half-suit
 * cards are removed from play, and the half-suit is marked as declared.
 *
 * @param {Object} gs
 * @param {string} declarerId
 * @param {string} halfSuitId
 * @returns {{ winningTeam: 1|2, newTurnPlayerId: string, lastMove: string }}
 */
function applyForcedFailedDeclaration(gs, declarerId, halfSuitId) {
  const halfSuitCards = buildHalfSuitMap(gs.variant).get(halfSuitId);
  const declarerTeam  = getPlayerTeam(gs, declarerId);
  const winningTeam   = declarerTeam === 1 ? 2 : 1;

  // Award point to opposing team
  if (winningTeam === 1) gs.scores.team1++;
  else gs.scores.team2++;

  // Remove all 6 half-suit cards from all hands
  for (const card of halfSuitCards) {
    for (const [, hand] of gs.hands) {
      hand.delete(card);
    }
  }

  // detect players whose hands are now empty for the first time
  const newlyEliminated = _detectNewlyEliminated(gs);

  // Mark as declared (won by opposing team)
  gs.declaredSuits.set(halfSuitId, { teamId: winningTeam, declaredBy: declarerId });

  // Build last-move string
  const suitName = halfSuitLabel(halfSuitId);
  gs.lastMove = `${_playerName(gs, declarerId)} ran out of time declaring ${suitName} — Team ${winningTeam} scores`;

  // Record move
  gs.moveHistory.push({
    type:        'declaration',
    declarerId,
    halfSuitId,
    assignment:  null,
    correct:     false,
    timedOut:    true,
    winningTeam,
    ts:          Date.now(),
  });

  // Update tiebreaker tracking
  if (halfSuitId === TIEBREAKER_HALF_SUIT) {
    gs.tiebreakerWinner = winningTeam;
  }

  // AC 29: forced-failed declaration always awards the point to opponents;
  // pass turn clockwise to the next eligible opponent.
  gs.currentTurnPlayerId = _nextClockwiseOpponent(gs, declarerId, winningTeam);

  // Check if game is over
  if (gs.declaredSuits.size === 8) {
    _endGame(gs);
  }

  return {
    winningTeam,
    newTurnPlayerId: gs.currentTurnPlayerId,
    lastMove:        gs.lastMove,
    newlyEliminated,
  };
}

// ---------------------------------------------------------------------------
// Game end
// ---------------------------------------------------------------------------

/**
 * Mark the game as completed and determine the winner.
 * @param {Object} gs
 */
function _endGame(gs) {
  gs.status = 'completed';

  const { team1, team2 } = gs.scores;

  if (team1 > team2) {
    gs.winner = 1;
  } else if (team2 > team1) {
    gs.winner = 2;
  } else {
    // Tied 4-4: tiebreaker = who declared high_d
    gs.winner = gs.tiebreakerWinner ?? null; // null = unexpected (should not happen with 8 suits)
  }
}

// ---------------------------------------------------------------------------
// Turn resolution
// ---------------------------------------------------------------------------

/**
 * Find the next clockwise player from `fromPlayerId` who belongs to
 * `opponentTeam` and has ≥1 card remaining (AC 29 — turn after failed declaration).
 *
 * "Clockwise" is defined by ascending seatIndex order, wrapping around.
 *
 * Falls back to:
 * 1. Any opponent with cards (regardless of seat order).
 * 2. _resolveValidTurn(gs, fromPlayerId) as a last resort.
 *
 * @param {Object} gs
 * @param {string} fromPlayerId — the declarer (turn passes FROM them)
 * @param {number} opponentTeam — the winning team (1 or 2)
 * @returns {string}
 */
function _nextClockwiseOpponent(gs, fromPlayerId, opponentTeam) {
  if (gs.status === 'completed') return fromPlayerId;

  // Players sorted clockwise by seatIndex.
  const sorted = [...gs.players].sort((a, b) => a.seatIndex - b.seatIndex);
  const fromIdx = sorted.findIndex((p) => p.playerId === fromPlayerId);
  const n = sorted.length;

  // Search clockwise (fromIdx+1, fromIdx+2, …) for an opponent with cards.
  for (let i = 1; i < n; i++) {
    const candidate = sorted[(fromIdx + i) % n];
    if (candidate.teamId === opponentTeam && getCardCount(gs, candidate.playerId) > 0) {
      return candidate.playerId;
    }
  }

  // Fallback 1: any opponent with cards (shouldn't differ from above, but defensive).
  const anyOpponent = sorted.find(
    (p) => p.teamId === opponentTeam && getCardCount(gs, p.playerId) > 0
  );
  if (anyOpponent) return anyOpponent.playerId;

  // Fallback 2: any player with cards (e.g. if opponents are all empty).
  return _resolveValidTurn(gs, fromPlayerId);
}

/**
 * Determine a valid turn holder starting from `candidateId`.
 *
 * If `candidateId` has ≥1 card, return them unchanged.
 * Otherwise, find the next player who has cards:
 * 1. Honour any stored turnRecipient designated by the eliminated player.
 * 2. AC 19: pass clockwise (ascending seatIndex, wrapping) to the next same-team
 * player who has ≥1 card. "Clockwise" is defined by seatIndex order so that the
 * turn stays within the correct team even when the designated turn-holder is
 * simultaneously eliminated (e.g. a correct declarant whose only cards were in
 * the just-declared half-suit).
 * 3. Fall back to any player with cards (all teammates empty).
 * 4. If nobody has cards (game should be over), return candidateId unchanged.
 *
 * @param {Object} gs
 * @param {string} candidateId
 * @returns {string}
 */
function _resolveValidTurn(gs, candidateId) {
  if (gs.status === 'completed') return candidateId;

  // If candidate has cards, they're fine.
  if (getCardCount(gs, candidateId) > 0) return candidateId;

  // if the eliminated player has designated a turn recipient, prefer them.
  const storedRecipient = gs.turnRecipients?.get(candidateId);
  if (storedRecipient && getCardCount(gs, storedRecipient) > 0) {
    return storedRecipient;
  }

  // AC 19: pass clockwise to the next same-team player with cards.
  const team = getPlayerTeam(gs, candidateId);
  const sorted = [...gs.players].sort((a, b) => a.seatIndex - b.seatIndex);
  const fromIdx = sorted.findIndex((p) => p.playerId === candidateId);
  const n = sorted.length;

  for (let i = 1; i < n; i++) {
    const candidate = sorted[(fromIdx + i) % n];
    if (candidate.teamId === team && getCardCount(gs, candidate.playerId) > 0) {
      return candidate.playerId;
    }
  }

  // Fall back to any player with cards (all teammates are empty).
  const anyWithCards = gs.players.find((p) => getCardCount(gs, p.playerId) > 0);
  if (anyWithCards) return anyWithCards.playerId;

  // Everyone is empty — game should have ended.
  return candidateId;
}

// ---------------------------------------------------------------------------
// Elimination helpers
// ---------------------------------------------------------------------------

/**
 * Scan all players: any player whose hand is now empty AND who was NOT
 * already in `gs.eliminatedPlayerIds` is newly eliminated.
 *
 * Adds the newly-eliminated IDs to `gs.eliminatedPlayerIds` (mutates).
 *
 * @param {Object} gs - GameState (mutated: eliminatedPlayerIds updated)
 * @returns {string[]} Array of newly-eliminated playerIds (may be empty)
 */
function _detectNewlyEliminated(gs) {
  const newlyEliminated = [];
  if (!gs.eliminatedPlayerIds) {
    gs.eliminatedPlayerIds = new Set();
  }
  for (const player of gs.players) {
    if (
      !gs.eliminatedPlayerIds.has(player.playerId) &&
      getCardCount(gs, player.playerId) === 0
    ) {
      gs.eliminatedPlayerIds.add(player.playerId);
      newlyEliminated.push(player.playerId);
    }
  }
  return newlyEliminated;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _playerName(gs, playerId) {
  const p = gs.players.find((pl) => pl.playerId === playerId);
  return p ? p.displayName : playerId;
}

function _findCardHolder(gs, cardId) {
  for (const [pid, hand] of gs.hands) {
    if (hand.has(cardId)) return pid;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Eligible next-turn players
// ---------------------------------------------------------------------------

/**
 * Compute the list of player IDs that are eligible to hold the turn.
 *
 * A player is eligible when ALL of the following are true:
 * 1. They have at least 1 card remaining in their hand.
 * 2. They are NOT in `gs.eliminatedPlayerIds` (i.e. their hand has not
 * been emptied by a previous declaration).
 *
 * This list is broadcast to all clients inside `declaration_result` after
 * every declaration so the UI can immediately highlight which seats are
 * still active participants. The list is purely informational — the
 * authoritative `newTurnPlayerId` field tells the clients WHO actually gets
 * the next turn; `eligibleNextTurnPlayerIds` tells them WHO COULD have.
 *
 * "Including declarant if applicable" means the declaring player appears in
 * the list when they still hold cards after the 6 half-suit cards are removed
 * (i.e. they were not eliminated by their own declaration).
 *
 * @param {Object} gs - GameState (after cards have been removed)
 * @returns {string[]} Array of playerIds ordered by seatIndex
 */
function getEligibleNextTurnPlayers(gs) {
  if (!gs || !gs.players) return [];

  return [...gs.players]
    .sort((a, b) => a.seatIndex - b.seatIndex)
    .filter((p) => {
      const hasCards = getCardCount(gs, p.playerId) > 0;
      const notEliminated = !(gs.eliminatedPlayerIds && gs.eliminatedPlayerIds.has(p.playerId));
      return hasCards && notEliminated;
    })
    .map((p) => p.playerId);
}

// ---------------------------------------------------------------------------
// Host migration helper
// ---------------------------------------------------------------------------

/**
 * Find the next eligible host candidate clockwise from `currentHostId`.
 *
 * Traverses the player list starting immediately after the current host
 * (ascending seatIndex, wrapping around) and returns the first player who
 * meets ALL of the following criteria:
 * 1. NOT a bot (`isBot === false`) — bots cannot take on the host role.
 * 2. NOT eliminated — their hand has not been emptied by a declaration
 * (i.e. their playerId is absent from `gs.eliminatedPlayerIds`).
 *
 * "Clockwise" is defined by ascending seatIndex, identical to the convention
 * used throughout the game engine (see `_resolveValidTurn`,
 * `_nextClockwiseOpponent`).
 *
 * Edge cases:
 * - If `currentHostId` is not found in the player list, traversal starts
 * from seatIndex 0 (i.e. the first player in seat order).
 * - Returns `null` when no eligible candidate exists (e.g. all remaining
 * players are bots or eliminated).
 * - A player with 0 cards who is NOT yet in `eliminatedPlayerIds` is still
 * eligible (the calling code should populate `eliminatedPlayerIds` before
 * invoking this function if card-emptiness matters).
 *
 * @param {Object} gs - GameState (must have `players` array and
 * optionally `eliminatedPlayerIds` Set)
 * @param {string} currentHostId - playerId of the current host
 * @returns {string|null} - playerId of the next eligible candidate,
 * or null if none is found
 */
function nextEligibleHostCandidate(gs, currentHostId) {
  if (!gs || !gs.players || gs.players.length === 0) return null;

  // Sort players clockwise by seatIndex (same convention as the rest of the engine).
  const sorted = [...gs.players].sort((a, b) => a.seatIndex - b.seatIndex);
  const n = sorted.length;

  const fromIdx = sorted.findIndex((p) => p.playerId === currentHostId);
  // If the host is not in the player list, start the search from index 0.
  const startIdx = fromIdx === -1 ? 0 : fromIdx;

  for (let i = 1; i < n; i++) {
    const candidate = sorted[(startIdx + i) % n];
    const isEliminated =
      gs.eliminatedPlayerIds != null &&
      gs.eliminatedPlayerIds.has(candidate.playerId);
    if (!candidate.isBot && !isEliminated) {
      return candidate.playerId;
    }
  }

  // No eligible candidate found (all remaining players are bots or eliminated).
  return null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  validateAsk,
  applyAsk,
  getDeclarantLockedCards,
  validateDeclaration,
  applyDeclaration,
  applyForcedFailedDeclaration,
  getEligibleNextTurnPlayers,
  nextEligibleHostCandidate,
  _resolveValidTurn,
  _nextClockwiseOpponent,
  _endGame,
  _detectNewlyEliminated,
};
