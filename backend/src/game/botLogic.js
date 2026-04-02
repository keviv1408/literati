'use strict';

/**
 * Bot decision-making for the Literati game.
 *
 * Bots use inference to track card locations:
 *   - When a player successfully gets a card, we know they have it.
 *   - When a player asks and fails, we know the target doesn't have that card.
 *   - When a declaration succeeds, we learn who held what.
 *
 * Decision priority:
 *   1. If public information uniquely identifies all 6 cards of a half-suit
 *      as being on the bot's team, declare it.
 *   2. If the bot knows an opponent holds a specific card in a half-suit the
 *      bot already has cards from, ask that opponent for it.
 *   3. Otherwise, randomly ask any opponent for any card in a half-suit the
 *      bot holds, preferring half-suits with more publicly-known team cards.
 *   4. If no valid ask is possible (all opponents empty), declare the
 *      best available half-suit using only public information plus the
 *      declarant's own hand.
 */

const { buildHalfSuitMap, buildCardToHalfSuitMap, allHalfSuitIds } = require('./halfSuits');
const {
  getHand,
  getCardCount,
  getHalfSuitCardCount,
  cardHalfSuit,
  getPlayerTeam,
  getTeamPlayers,
  isHalfSuitDeclared,
} = require('./gameState');
const { validateAsk, validateDeclaration } = require('./gameEngine');

const TEAM_SIGNAL_MAX_STRENGTH = 6;
const TEAM_SIGNAL_SUCCESS_BOOST = 3;
const TEAM_SIGNAL_FAILED_ASK_BOOST = 2;
const TEAM_SIGNAL_DECAY_INTERVAL_MOVES = 3;

// ---------------------------------------------------------------------------
// Inference helpers
// ---------------------------------------------------------------------------

/**
 * Update bot knowledge after an ask event.
 * @param {Object} gs
 * @param {string} askerId
 * @param {string} targetId
 * @param {string} cardId
 * @param {boolean} success
 */
function updateKnowledgeAfterAsk(gs, askerId, targetId, cardId, success) {
  if (success) {
    // The asker now holds the card.
    _setKnown(gs, askerId, cardId, true);
    _setKnown(gs, targetId, cardId, false);
  } else {
    // The target does NOT hold the card.
    _setKnown(gs, targetId, cardId, false);
  }
}

/**
 * Update bot knowledge after a declaration.
 * @param {Object} gs
 * @param {string} halfSuitId
 * @param {Object.<string, string>} assignment - { cardId: playerId }
 * @param {boolean} correct
 */
function updateKnowledgeAfterDeclaration(gs, halfSuitId, assignment, correct) {
  if (correct) {
    // We learn the exact card locations (confirmed).
    for (const [card, playerId] of Object.entries(assignment)) {
      // These cards are now removed, but mark as false for everyone since they're gone.
      for (const player of gs.players) {
        _setKnown(gs, player.playerId, card, false);
      }
    }
  }
  // After declaration, all 6 cards are removed from play — no knowledge needed.
}

function _setKnown(gs, playerId, cardId, value) {
  if (!gs.botKnowledge.has(playerId)) {
    gs.botKnowledge.set(playerId, new Map());
  }
  gs.botKnowledge.get(playerId).set(cardId, value);
}

function _getKnown(gs, playerId, cardId) {
  const playerKnowledge = gs.botKnowledge.get(playerId);
  if (!playerKnowledge) return null;
  const val = playerKnowledge.get(cardId);
  return val === undefined ? null : val;
}

function _isKnownMissing(gs, playerId, cardId) {
  return _getEffectiveKnowledge(gs, playerId, cardId) === false;
}

function _getEffectiveKnowledge(gs, playerId, cardId) {
  const explicit = _getKnown(gs, playerId, cardId);
  if (explicit !== null) return explicit;

  const halfSuitId = cardHalfSuit(gs, cardId);
  if (!halfSuitId) return null;

  const halfSuitCards = buildHalfSuitMap(gs.variant).get(halfSuitId) ?? [];
  const halfSuitCount = getHalfSuitCardCount(gs, playerId, halfSuitId);

  if (halfSuitCount === 0) {
    return false;
  }

  let knownTrueCount = 0;
  let unknownCount = 0;
  let cardIsUnknown = false;

  for (const candidate of halfSuitCards) {
    const knowledge = _getKnown(gs, playerId, candidate);
    if (knowledge === true) {
      knownTrueCount++;
      if (candidate === cardId) return true;
      continue;
    }
    if (knowledge === null) {
      unknownCount++;
      if (candidate === cardId) cardIsUnknown = true;
    }
  }

  if (!cardIsUnknown) {
    return null;
  }

  const remainingSlots = halfSuitCount - knownTrueCount;
  if (remainingSlots <= 0) {
    return false;
  }
  if (unknownCount === remainingSlots) {
    return true;
  }

  return null;
}

function _ensureTeamIntentMemory(gs) {
  if (!(gs.teamIntentMemory instanceof Map)) {
    gs.teamIntentMemory = new Map();
  }
  return gs.teamIntentMemory;
}

function _getOrCreateTeamSignals(gs, teamId) {
  const memory = _ensureTeamIntentMemory(gs);
  if (!memory.has(teamId)) {
    memory.set(teamId, new Map());
  }
  return memory.get(teamId);
}

function _effectiveSignalStrength(entry, currentMoveIndex) {
  if (!entry) return 0;
  const lastUpdated = entry.lastUpdatedMoveIndex ?? 0;
  const age = Math.max(0, currentMoveIndex - lastUpdated);
  const decay = Math.floor(age / TEAM_SIGNAL_DECAY_INTERVAL_MOVES);
  return Math.max(0, (entry.strength ?? 0) - decay);
}

function _getTeamSignalStrength(gs, teamId, halfSuitId, currentMoveIndex = (gs.moveHistory ?? []).length) {
  if (!(gs.teamIntentMemory instanceof Map)) return 0;
  const teamSignals = gs.teamIntentMemory.get(teamId);
  if (!(teamSignals instanceof Map)) return 0;
  const entry = teamSignals.get(halfSuitId);
  const strength = _effectiveSignalStrength(entry, currentMoveIndex);
  if (strength <= 0 && entry) {
    teamSignals.delete(halfSuitId);
  }
  return strength;
}

function updateTeamIntentAfterAsk(gs, askerId, cardId, success) {
  const teamId = getPlayerTeam(gs, askerId);
  const halfSuitId = cardHalfSuit(gs, cardId);
  if (!teamId || !halfSuitId) return;

  const currentMoveIndex = (gs.moveHistory ?? []).length;
  const teamSignals = _getOrCreateTeamSignals(gs, teamId);
  const currentStrength = _getTeamSignalStrength(gs, teamId, halfSuitId, currentMoveIndex);
  const boost = success ? TEAM_SIGNAL_SUCCESS_BOOST : TEAM_SIGNAL_FAILED_ASK_BOOST;

  teamSignals.set(halfSuitId, {
    strength: Math.min(TEAM_SIGNAL_MAX_STRENGTH, currentStrength + boost),
    lastUpdatedMoveIndex: currentMoveIndex,
    sourcePlayerId: askerId,
    lastOutcome: success ? 'success' : 'failure',
  });
}

function updateTeamIntentAfterDeclaration(gs, halfSuitId) {
  if (!(gs.teamIntentMemory instanceof Map)) return;
  for (const teamSignals of gs.teamIntentMemory.values()) {
    if (teamSignals instanceof Map) {
      teamSignals.delete(halfSuitId);
    }
  }
}

function _getPublicTeamHalfSuitCount(gs, teamPlayers, halfSuitId) {
  return teamPlayers.reduce(
    (sum, p) => sum + getHalfSuitCardCount(gs, p.playerId, halfSuitId),
    0
  );
}

function _findKnownHolder(gs, cardId) {
  let holder = null;

  for (const player of gs.players) {
    if (_getEffectiveKnowledge(gs, player.playerId, cardId) !== true) continue;
    if (holder && holder !== player.playerId) return '__conflict__';
    holder = player.playerId;
  }

  return holder;
}

/**
 * Search for team-only assignments that are consistent with public information.
 *
 * Public constraints considered:
 *   - per-player half-suit counts
 *   - publicly observed ask outcomes stored in botKnowledge
 *   - the declarant's own hand
 *   - any partial assignments already made in the declaration UI
 *
 * @param {Object} gs
 * @param {string} declarerId
 * @param {string} halfSuitId
 * @param {string[]} cards
 * @param {Array<{playerId:string}>} teamPlayers
 * @param {Object.<string, string>} partialAssignment
 * @param {number} maxSolutions
 * @returns {Array<Object.<string, string>>}
 */
function _searchPublicAssignments(
  gs,
  declarerId,
  halfSuitId,
  cards,
  teamPlayers,
  partialAssignment = {},
  maxSolutions = 2
) {
  const teamPlayerIds = new Set(teamPlayers.map((p) => p.playerId));
  const remainingCounts = new Map(
    teamPlayers.map((p) => [p.playerId, getHalfSuitCardCount(gs, p.playerId, halfSuitId)])
  );
  const assignment = {};

  function applyForced(card, playerId) {
    const existing = assignment[card];
    if (existing) return existing === playerId;
    if (!teamPlayerIds.has(playerId)) return false;
    if (_isKnownMissing(gs, playerId, card)) return false;

    const remaining = remainingCounts.get(playerId);
    if (remaining == null || remaining <= 0) return false;

    assignment[card] = playerId;
    remainingCounts.set(playerId, remaining - 1);
    return true;
  }

  for (const [card, playerId] of Object.entries(partialAssignment)) {
    if (!cards.includes(card)) continue;
    if (!applyForced(card, playerId)) return [];
  }

  const declarerHand = getHand(gs, declarerId);
  for (const card of cards) {
    if (declarerHand.has(card) && !applyForced(card, declarerId)) {
      return [];
    }
  }

  for (const card of cards) {
    const knownHolder = _findKnownHolder(gs, card);
    if (knownHolder === '__conflict__') return [];
    if (knownHolder && !applyForced(card, knownHolder)) {
      return [];
    }
  }

  const unassignedCards = cards.filter((card) => !assignment[card]);
  const remainingSlots = Array.from(remainingCounts.values()).reduce((sum, n) => sum + n, 0);
  if (remainingSlots !== unassignedCards.length) return [];

  const candidateMap = new Map();
  for (const card of unassignedCards) {
    const candidates = teamPlayers
      .map((p) => p.playerId)
      .filter((playerId) => remainingCounts.get(playerId) > 0 && !_isKnownMissing(gs, playerId, card));
    if (candidates.length === 0) return [];
    candidateMap.set(card, candidates);
  }

  const orderedCards = [...unassignedCards].sort((a, b) => {
    const diff = candidateMap.get(a).length - candidateMap.get(b).length;
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  const solutions = [];

  function backtrack(index) {
    if (solutions.length >= maxSolutions) return;

    if (index >= orderedCards.length) {
      if (Array.from(remainingCounts.values()).every((n) => n === 0)) {
        solutions.push({ ...assignment });
      }
      return;
    }

    const card = orderedCards[index];
    const candidates = candidateMap
      .get(card)
      .filter((playerId) => remainingCounts.get(playerId) > 0)
      .sort((a, b) => {
        const diff = remainingCounts.get(a) - remainingCounts.get(b);
        return diff !== 0 ? diff : a.localeCompare(b);
      });

    for (const playerId of candidates) {
      assignment[card] = playerId;
      remainingCounts.set(playerId, remainingCounts.get(playerId) - 1);
      backtrack(index + 1);
      remainingCounts.set(playerId, remainingCounts.get(playerId) + 1);
      delete assignment[card];
      if (solutions.length >= maxSolutions) return;
    }
  }

  backtrack(0);
  return solutions;
}

/**
 * Fill a declaration assignment without peeking at teammate hands.
 *
 * Prefers any assignment that is fully consistent with public information.
 * If none exists, falls back to a team-only guess while preserving partial
 * assignments and the declarant's own known cards.
 *
 * @param {Object} gs
 * @param {string} declarerId
 * @param {string} halfSuitId
 * @param {string[]} cards
 * @param {Array<{playerId:string}>} teamPlayers
 * @param {Object.<string, string>} partialAssignment
 * @returns {Object.<string, string>}
 */
function _buildBestGuessAssignment(
  gs,
  declarerId,
  halfSuitId,
  cards,
  teamPlayers,
  partialAssignment = {}
) {
  const publicSolutions = _searchPublicAssignments(
    gs,
    declarerId,
    halfSuitId,
    cards,
    teamPlayers,
    partialAssignment,
    1
  );
  if (publicSolutions.length > 0) {
    return publicSolutions[0];
  }

  const teamPlayerIds = teamPlayers.map((p) => p.playerId);
  const assignment = { ...partialAssignment };
  const remainingCounts = new Map(
    teamPlayers.map((p) => [p.playerId, getHalfSuitCardCount(gs, p.playerId, halfSuitId)])
  );

  function consumeSlot(playerId) {
    const remaining = remainingCounts.get(playerId);
    if (remaining == null) return;
    remainingCounts.set(playerId, Math.max(remaining - 1, 0));
  }

  for (const [, playerId] of Object.entries(partialAssignment)) {
    consumeSlot(playerId);
  }

  const declarerHand = getHand(gs, declarerId);
  for (const card of cards) {
    if (!assignment[card] && declarerHand.has(card)) {
      assignment[card] = declarerId;
      consumeSlot(declarerId);
    }
  }

  for (const card of cards) {
    if (assignment[card]) continue;
    const knownHolder = _findKnownHolder(gs, card);
    if (knownHolder && knownHolder !== '__conflict__' && teamPlayerIds.includes(knownHolder)) {
      assignment[card] = knownHolder;
      consumeSlot(knownHolder);
    }
  }

  for (const card of cards) {
    if (assignment[card]) continue;

    const candidates = teamPlayerIds.filter((playerId) => !_isKnownMissing(gs, playerId, card));
    const safeCandidates = candidates.length > 0 ? candidates : teamPlayerIds;
    const preferred = safeCandidates.filter((playerId) => (remainingCounts.get(playerId) ?? 0) > 0);
    const pool = preferred.length > 0 ? preferred : safeCandidates;

    const bestRemaining = Math.max(...pool.map((playerId) => remainingCounts.get(playerId) ?? 0));
    const strongest = pool.filter((playerId) => (remainingCounts.get(playerId) ?? 0) === bestRemaining);
    const assignee = strongest[Math.floor(Math.random() * strongest.length)];
    assignment[card] = assignee;
    consumeSlot(assignee);
  }

  return assignment;
}

function _findKnownHolderAsk(gs, askerId, validOpponents, candidateCards) {
  const shuffledCards = _shuffle([...candidateCards]);
  const shuffledOpps  = _shuffle([...validOpponents]);

  for (const card of shuffledCards) {
    for (const opp of shuffledOpps) {
      if (_getEffectiveKnowledge(gs, opp.playerId, card) !== true) continue;
      const askVal = validateAsk(gs, askerId, opp.playerId, card);
      if (askVal.valid) {
        return { action: 'ask', targetId: opp.playerId, cardId: card };
      }
    }
  }

  return null;
}

function _findUnknownAsk(gs, askerId, validOpponents, candidateCards) {
  const shuffledCards = _shuffle([...candidateCards]);
  const shuffledOpps  = _shuffle([...validOpponents]);

  for (const card of shuffledCards) {
    for (const opp of shuffledOpps) {
      if (_isKnownMissing(gs, opp.playerId, card)) continue;
      const askVal = validateAsk(gs, askerId, opp.playerId, card);
      if (askVal.valid) {
        return { action: 'ask', targetId: opp.playerId, cardId: card };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Bot decision
// ---------------------------------------------------------------------------

/**
 * Decide the next move for a bot player.
 *
 * Returns either:
 *   { action: 'ask', targetId, cardId }
 *   { action: 'declare', halfSuitId, assignment: { [cardId]: playerId } }
 *   { action: 'pass' }   (fallback — should be rare)
 *
 * @param {Object} gs - GameState
 * @param {string} botId - The bot's player ID
 * @returns {{ action: string, targetId?: string, cardId?: string, halfSuitId?: string, assignment?: Object }}
 */
function decideBotMove(gs, botId) {
  const botTeam    = getPlayerTeam(gs, botId);
  const teammates  = getTeamPlayers(gs, botTeam).filter((p) => p.playerId !== botId);
  const opponents  = gs.players.filter((p) => getPlayerTeam(gs, p.playerId) !== botTeam);
  const validOpponents = opponents.filter((p) => getCardCount(gs, p.playerId) > 0);
  const teamPlayers = [{ playerId: botId }, ...teammates];
  const currentMoveIndex = (gs.moveHistory ?? []).length;

  const halfSuitsMap  = buildHalfSuitMap(gs.variant);
  const cardToHalfSuit = buildCardToHalfSuitMap(gs.variant);

  // Collect all undeclared half-suits
  const undeclaredHalfSuits = allHalfSuitIds().filter((id) => !isHalfSuitDeclared(gs, id));

  // ── Priority 1: Declare if team definitely holds all 6 cards of a half-suit ─
  for (const halfSuitId of undeclaredHalfSuits) {
    const declareCheck = _tryBuildDeclaration(gs, botId, halfSuitId, halfSuitsMap, teammates);
    if (declareCheck) {
      const validation = validateDeclaration(gs, botId, halfSuitId, declareCheck);
      if (validation.valid) {
        return { action: 'declare', halfSuitId, assignment: declareCheck };
      }
    }
  }

  // ── Priority 2: Ask for a card we KNOW an opponent has ───────────────────────
  if (validOpponents.length > 0) {
    const botHand = getHand(gs, botId);

    // Find half-suits where the bot has at least one card
    const botHalfSuits = new Set();
    for (const card of botHand) {
      const hs = cardToHalfSuit.get(card);
      if (hs && !isHalfSuitDeclared(gs, hs)) {
        botHalfSuits.add(hs);
      }
    }

    const suitPriority = new Map(
      [...botHalfSuits].map((halfSuitId) => [
        halfSuitId,
        {
          signalStrength: _getTeamSignalStrength(gs, botTeam, halfSuitId, currentMoveIndex),
          teamCount: _getPublicTeamHalfSuitCount(gs, teamPlayers, halfSuitId),
        },
      ])
    );
    const prioritizedBotHalfSuits = [...botHalfSuits].sort((a, b) => {
      const aPriority = suitPriority.get(a);
      const bPriority = suitPriority.get(b);
      const signalDiff = (bPriority?.signalStrength ?? 0) - (aPriority?.signalStrength ?? 0);
      if (signalDiff !== 0) return signalDiff;
      const teamCountDiff = (bPriority?.teamCount ?? 0) - (aPriority?.teamCount ?? 0);
      if (teamCountDiff !== 0) return teamCountDiff;
      return a.localeCompare(b);
    });

    // For each half-suit the bot can ask from, look for known opponent cards
    for (const halfSuitId of prioritizedBotHalfSuits) {
      const cards = halfSuitsMap.get(halfSuitId) ?? [];
      const neededCards = cards.filter((card) => !botHand.has(card));
      const knownAsk = _findKnownHolderAsk(gs, botId, validOpponents, neededCards);
      if (knownAsk) return knownAsk;
    }

    // ── Priority 3: Random ask in a half-suit the bot has cards from ──────────
    // Prefer half-suits where public information says the team is closer to completion.
    const halfSuitScores = [];
    for (const halfSuitId of prioritizedBotHalfSuits) {
      if (isHalfSuitDeclared(gs, halfSuitId)) continue;
      const cards = halfSuitsMap.get(halfSuitId) ?? [];
      const priority = suitPriority.get(halfSuitId) ?? { signalStrength: 0, teamCount: 0 };

      // Cards in this suit not held by the bot = potentially askable
      const askableCards = cards.filter((c) => !getHand(gs, botId).has(c));

      if (askableCards.length > 0) {
        halfSuitScores.push({
          halfSuitId,
          signalStrength: priority.signalStrength,
          teamCount: priority.teamCount,
          askableCards,
        });
      }
    }

    // Prefer teammate-signaled suits first, then suits closer to completion.
    halfSuitScores.sort((a, b) => {
      const signalDiff = b.signalStrength - a.signalStrength;
      if (signalDiff !== 0) return signalDiff;
      const teamCountDiff = b.teamCount - a.teamCount;
      if (teamCountDiff !== 0) return teamCountDiff;
      return a.halfSuitId.localeCompare(b.halfSuitId);
    });

    for (const { halfSuitId, askableCards } of halfSuitScores) {
      // Keep random fallback from repeating asks that public information has
      // already ruled out for that target/card combination.
      const unknownAsk = _findUnknownAsk(gs, botId, validOpponents, askableCards);
      if (unknownAsk) return unknownAsk;
    }
  }

  // ── Fallback: Declare whichever half-suit has the most team cards ────────────
  // Even if we're not 100% sure — use best-guess assignment
  const bestGuessDecl = _findBestGuessDeclaration(gs, botId, undeclaredHalfSuits, halfSuitsMap, teammates);
  if (bestGuessDecl) {
    return bestGuessDecl;
  }

  // Absolute fallback: should not reach here in a valid game state
  return { action: 'pass' };
}

// ---------------------------------------------------------------------------
// Declaration helpers
// ---------------------------------------------------------------------------

/**
 * Try to build a valid declaration assignment for a half-suit.
 * Only returns an assignment if the bot is CERTAIN the team holds all 6 cards.
 *
 * @param {Object} gs
 * @param {string} botId
 * @param {string} halfSuitId
 * @param {Map} halfSuitsMap
 * @param {Array} teammates
 * @returns {Object|null} { [cardId]: playerId } or null
 */
function _tryBuildDeclaration(gs, botId, halfSuitId, halfSuitsMap, teammates) {
  const cards = halfSuitsMap.get(halfSuitId) ?? [];
  const teamPlayers = [{ playerId: botId }, ...teammates];
  if (_getPublicTeamHalfSuitCount(gs, teamPlayers, halfSuitId) !== cards.length) {
    return null;
  }

  const solutions = _searchPublicAssignments(gs, botId, halfSuitId, cards, teamPlayers, {}, 2);
  return solutions.length === 1 ? solutions[0] : null;
}

/**
 * Find the best half-suit to declare as a guess (fallback).
 * Returns a declare action with best-guess assignment.
 *
 * @param {Object} gs
 * @param {string} botId
 * @param {string[]} undeclaredHalfSuits
 * @param {Map} halfSuitsMap
 * @param {Array} teammates
 * @returns {{ action: 'declare', halfSuitId, assignment }|null}
 */
function _findBestGuessDeclaration(gs, botId, undeclaredHalfSuits, halfSuitsMap, teammates) {
  const teamPlayers = [{ playerId: botId }, ...teammates];
  const botHand = getHand(gs, botId);

  let bestSuit = null;
  let bestCount = -1;
  let bestAssignment = null;

  for (const halfSuitId of undeclaredHalfSuits) {
    const cards = halfSuitsMap.get(halfSuitId) ?? [];
    const botHasCard = cards.some((card) => botHand.has(card));
    if (!botHasCard) continue;

    // Only consider half-suits where public information says the team has
    // at least one card and the declarer can legally declare the suit.
    const count = _getPublicTeamHalfSuitCount(gs, teamPlayers, halfSuitId);
    if (count > 0 && count > bestCount) {
      bestCount  = count;
      bestSuit   = halfSuitId;
      bestAssignment = _buildBestGuessAssignment(gs, botId, halfSuitId, cards, teamPlayers, {});
    }
  }

  if (bestSuit && bestAssignment) {
    return { action: 'declare', halfSuitId: bestSuit, assignment: bestAssignment };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Bot completion from partial selection
// ---------------------------------------------------------------------------

/**
 * Complete a bot/timed-out human player's action using partial selection state.
 *
 * Called when a human player's turn timer fires and they have already
 * progressed partway through the ask or declare wizard:
 *
 *   Ask step 2 entered (half-suit chosen):
 *     partial = { flow: 'ask', halfSuitId: string }
 *     → bot picks a valid card from that half-suit and a valid opponent.
 *
 *   Ask step 3 entered (card also chosen):
 *     partial = { flow: 'ask', halfSuitId: string, cardId: string }
 *     → bot picks a valid opponent for the already-chosen card.
 *
 *   Declare (suit chosen, possibly with partial assignment):
 *     partial = { flow: 'declare', halfSuitId: string, assignment?: Record<string,string> }
 *     → bot fills any unassigned cards with best-guess teammates.
 *
 * Falls back to a full `decideBotMove()` call in any of these cases:
 *   • `partial` is null/undefined or has no `flow` field
 *   • The referenced half-suit is already declared
 *   • The referenced card is no longer askable (already held, game-state changed)
 *   • No valid opponents remain
 *
 * @param {Object} gs         - GameState
 * @param {string} playerId   - The player whose turn it is
 * @param {Object|null} partial - Partial selection state (or null to fallback)
 * @returns {{ action: string, targetId?: string, cardId?: string, halfSuitId?: string, assignment?: Object }}
 */
function completeBotFromPartial(gs, playerId, partial) {
  if (!partial || typeof partial.flow !== 'string') {
    return decideBotMove(gs, playerId);
  }

  const halfSuitsMap = buildHalfSuitMap(gs.variant);

  switch (partial.flow) {
    case 'ask':
      return _completeAsk(gs, playerId, partial, halfSuitsMap);
    case 'declare':
      return _completeDeclare(gs, playerId, partial, halfSuitsMap);
    default:
      return decideBotMove(gs, playerId);
  }
}

/**
 * Complete an in-progress ask flow.
 * @private
 */
function _completeAsk(gs, playerId, partial, halfSuitsMap) {
  const { halfSuitId, cardId: partialCardId } = partial;

  // Guard: half-suit must be known, valid for this variant, and not yet declared
  if (!halfSuitId || isHalfSuitDeclared(gs, halfSuitId)) {
    return decideBotMove(gs, playerId);
  }

  const botTeam        = getPlayerTeam(gs, playerId);
  const opponents      = gs.players.filter((p) => getPlayerTeam(gs, p.playerId) !== botTeam);
  const validOpponents = opponents.filter((p) => getCardCount(gs, p.playerId) > 0);

  if (validOpponents.length === 0) {
    // No opponents to ask — must declare instead
    return decideBotMove(gs, playerId);
  }

  // ── Step 3: card already chosen — just need a valid opponent ──────────────
  if (partialCardId) {
    const knownAsk = _findKnownHolderAsk(gs, playerId, validOpponents, [partialCardId]);
    if (knownAsk) return knownAsk;

    const unknownAsk = _findUnknownAsk(gs, playerId, validOpponents, [partialCardId]);
    if (unknownAsk) return unknownAsk;

    // Chosen card is no longer askable (e.g. game state changed) — full fallback
    return decideBotMove(gs, playerId);
  }

  // ── Step 2: only half-suit chosen — need card + opponent ──────────────────
  const cards    = halfSuitsMap.get(halfSuitId) ?? [];
  const myHand   = getHand(gs, playerId);
  const askable  = cards.filter((c) => !myHand.has(c));

  if (askable.length === 0) {
    return decideBotMove(gs, playerId);
  }

  const knownAsk = _findKnownHolderAsk(gs, playerId, validOpponents, askable);
  if (knownAsk) return knownAsk;

  const unknownAsk = _findUnknownAsk(gs, playerId, validOpponents, askable);
  if (unknownAsk) return unknownAsk;

  return decideBotMove(gs, playerId);
}

/**
 * Complete an in-progress declare flow.
 * @private
 */
function _completeDeclare(gs, playerId, partial, halfSuitsMap) {
  const { halfSuitId, assignment: partialAssignment = {} } = partial;

  // Guard: half-suit must be known, valid, and not yet declared
  if (!halfSuitId || isHalfSuitDeclared(gs, halfSuitId)) {
    return decideBotMove(gs, playerId);
  }

  const cards = halfSuitsMap.get(halfSuitId) ?? [];
  if (cards.length === 0) {
    return decideBotMove(gs, playerId);
  }

  const botTeam    = getPlayerTeam(gs, playerId);
  const teamPlayers = getTeamPlayers(gs, botTeam);
  const fullAssignment = _buildBestGuessAssignment(
    gs,
    playerId,
    halfSuitId,
    cards,
    teamPlayers,
    partialAssignment
  );

  // Validate before executing — fall back if the completed assignment is still invalid
  const validation = validateDeclaration(gs, playerId, halfSuitId, fullAssignment);
  if (validation.valid) {
    return { action: 'declare', halfSuitId, assignment: fullAssignment };
  }

  return decideBotMove(gs, playerId);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function _shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = {
  decideBotMove,
  completeBotFromPartial,
  updateKnowledgeAfterAsk,
  updateKnowledgeAfterDeclaration,
  updateTeamIntentAfterAsk,
  updateTeamIntentAfterDeclaration,
};
