'use strict';

/**
 * Bot decision-making for the Literati game.
 *
 * Bots use only seat-visible information to track card locations:
 *   - their own hand
 *   - When a player successfully gets a card, we know they have it.
 *   - When a player asks and fails, we know the target doesn't have that card.
 *   - public hand sizes, which cap how many unknown cards a player could hold.
 *
 * Decision priority:
 *   1. If public information uniquely identifies all 6 cards of a half-suit
 *      as being on the bot's team, declare it.
 *   2. If the bot knows an opponent holds a specific card in a half-suit the
 *      bot already has cards from, ask that opponent for it.
 *   3. Otherwise, ask any opponent for any card in a half-suit the bot holds,
 *      preferring half-suits with more publicly-known team cards.
 *   4. If public information has ruled out every reasonable target but
 *      opponents still have cards, make a signaling ask instead of guessing a
 *      declaration.
 *   5. If no legal ask is possible at all (for example, all opponents are
 *      empty), declare the best available half-suit using only public
 *      information plus the declarant's own hand.
 */

const { buildHalfSuitMap, buildCardToHalfSuitMap, allHalfSuitIds } = require('./halfSuits');
const {
  getHand,
  getCardCount,
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
const TEAM_CLOSEOUT_PRIORITY_THRESHOLD = 4;
const TEAMMATE_ASSIST_PRIORITY_THRESHOLD = 4;
const TEAMMATE_ASSIST_MEMORY_MOVES = 8;

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
    // A failed public ask proves that neither player held the card at that moment:
    // the target denied it, and the asker could not already have been holding it.
    _setKnown(gs, askerId, cardId, false);
    _setKnown(gs, targetId, cardId, false);
  }

  // Game rule: you can only ask for a card in a half-suit you hold at least
  // one card from. So the asker is publicly known to hold ≥1 card in this
  // half-suit.
  const hsId = cardHalfSuit(gs, cardId);
  if (hsId) {
    _markHalfSuitPresence(gs, askerId, hsId);
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
  const removedCards = buildHalfSuitMap(gs.variant).get(halfSuitId) ?? Object.keys(assignment);

  // Regardless of whether the declaration was correct, the entire half-suit is
  // removed from play and is therefore known to be absent from every hand.
  for (const card of removedCards) {
    for (const player of gs.players) {
      _setKnown(gs, player.playerId, card, false);
    }
  }

  // Clear half-suit presence flags — the suit is out of play.
  if (gs.botHalfSuitPresence instanceof Map) {
    for (const set of gs.botHalfSuitPresence.values()) {
      if (set instanceof Set) set.delete(halfSuitId);
    }
  }

  if (!correct) return;
  // No additional holder information is needed here; the suit is out of play.
}

function _markHalfSuitPresence(gs, playerId, halfSuitId) {
  if (!(gs.botHalfSuitPresence instanceof Map)) {
    gs.botHalfSuitPresence = new Map();
  }
  if (!gs.botHalfSuitPresence.has(playerId)) {
    gs.botHalfSuitPresence.set(playerId, new Set());
  }
  gs.botHalfSuitPresence.get(playerId).add(halfSuitId);
}

function _hasHalfSuitPresence(gs, playerId, halfSuitId) {
  if (!(gs.botHalfSuitPresence instanceof Map)) return false;
  const set = gs.botHalfSuitPresence.get(playerId);
  return set instanceof Set && set.has(halfSuitId);
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

function _isKnownMissing(gs, observerId, playerId, cardId) {
  return _getEffectiveKnowledge(gs, observerId, playerId, cardId) === false;
}

function _getVisibleKnownHolder(gs, observerId, cardId) {
  if (observerId && getHand(gs, observerId).has(cardId)) {
    return observerId;
  }

  let holder = null;

  for (const player of gs.players) {
    if (_getKnown(gs, player.playerId, cardId) !== true) continue;
    if (holder && holder !== player.playerId) return '__conflict__';
    holder = player.playerId;
  }

  if (holder) return holder;

  // Process-of-elimination: if all players except one are known to NOT hold
  // this card, the remaining player must hold it. This uses only public ask
  // outcomes and the observer's own hand — no hidden information.
  let candidate = null;
  for (const player of gs.players) {
    const known = _getKnown(gs, player.playerId, cardId);
    if (known === true) return player.playerId;
    if (known === false) continue;
    // Empty-handed players can't hold any card.
    if (getCardCount(gs, player.playerId) === 0) continue;
    // More than one possible holder — can't deduce.
    if (candidate) return null;
    candidate = player.playerId;
  }

  return candidate;
}

/**
 * Return the team that publicly must hold a card, even if the exact holder is
 * unknown.  When process-of-elimination narrows a card's possible holders to
 * multiple players who are ALL on the same team, we can infer the team without
 * knowing which player holds it.
 *
 * Returns 1|2 if the team is deterministic, null otherwise.
 */
function _getVisibleKnownTeam(gs, observerId, cardId) {
  const holder = _getVisibleKnownHolder(gs, observerId, cardId);
  if (holder && holder !== '__conflict__') {
    return getPlayerTeam(gs, holder);
  }

  // holder is null — multiple candidates exist.  Check if they all share a team.
  let team = null;
  for (const player of gs.players) {
    const known = _getKnown(gs, player.playerId, cardId);
    if (known === true) return getPlayerTeam(gs, player.playerId);
    if (known === false) continue;
    if (getCardCount(gs, player.playerId) === 0) continue;
    // This player is a candidate.
    const pTeam = player.teamId;
    if (team === null) {
      team = pTeam;
    } else if (team !== pTeam) {
      return null; // candidates span both teams
    }
  }

  return team;
}

function _getVisibleKnownCards(gs, observerId, playerId) {
  if (observerId === playerId) {
    return new Set(getHand(gs, playerId));
  }

  const visibleCards = new Set();
  const knowledge = gs.botKnowledge.get(playerId);
  if (!(knowledge instanceof Map)) return visibleCards;

  for (const [cardId, value] of knowledge.entries()) {
    if (value === true) visibleCards.add(cardId);
  }

  return visibleCards;
}

function _getVisibleTargetCapacity(gs, observerId, playerId, halfSuitId) {
  const totalCards = getCardCount(gs, playerId);
  const visibleCards = _getVisibleKnownCards(gs, observerId, playerId);
  let knownOutsideSuit = 0;

  for (const cardId of visibleCards) {
    if (cardHalfSuit(gs, cardId) !== halfSuitId) {
      knownOutsideSuit++;
    }
  }

  return Math.max(0, totalCards - knownOutsideSuit);
}

function _getEffectiveKnowledge(gs, observerId, playerId, cardId) {
  if (observerId === playerId) {
    return getHand(gs, observerId).has(cardId);
  }

  const explicit = _getKnown(gs, playerId, cardId);
  if (explicit !== null) return explicit;

  const visibleHolder = _getVisibleKnownHolder(gs, observerId, cardId);
  if (!visibleHolder || visibleHolder === '__conflict__') return null;
  return visibleHolder === playerId;
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

function _getTeamSignalEntry(gs, teamId, halfSuitId) {
  if (!(gs.teamIntentMemory instanceof Map)) return null;
  const teamSignals = gs.teamIntentMemory.get(teamId);
  if (!(teamSignals instanceof Map)) return null;
  return teamSignals.get(halfSuitId) ?? null;
}

function _getTeammateAssistPriority(gs, botId, teamId, halfSuitId, teamCount, currentMoveIndex) {
  if (teamCount < TEAMMATE_ASSIST_PRIORITY_THRESHOLD) return 0;

  const entry = _getTeamSignalEntry(gs, teamId, halfSuitId);
  if (!entry) return 0;
  if (!entry.sourcePlayerId || entry.sourcePlayerId === botId) return 0;

  const age = Math.max(0, currentMoveIndex - (entry.lastUpdatedMoveIndex ?? 0));
  if (age > TEAMMATE_ASSIST_MEMORY_MOVES) return 0;

  const sourcePlayer = gs.players.find((player) => player.playerId === entry.sourcePlayerId);
  const sourceBonus = sourcePlayer && !sourcePlayer.isBot ? 1 : 0;
  const signalStrength = _effectiveSignalStrength(entry, currentMoveIndex);

  // Keep a recently signaled teammate chase sticky enough to survive a full
  // table rotation, especially when a human teammate started the suit.
  return teamCount + Math.max(signalStrength, 1) + sourceBonus;
}

function _getRecentTeammateSignalEntry(gs, botId, teamId, halfSuitId, currentMoveIndex) {
  const entry = _getTeamSignalEntry(gs, teamId, halfSuitId);
  if (!entry) return null;
  if (!entry.sourcePlayerId || entry.sourcePlayerId === botId) return null;

  const age = Math.max(0, currentMoveIndex - (entry.lastUpdatedMoveIndex ?? 0));
  if (age > TEAMMATE_ASSIST_MEMORY_MOVES) return null;

  return entry;
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
    focusCardId: cardId,
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

function _getVisibleTeamHalfSuitCount(gs, observerId, teamPlayers, halfSuitId) {
  const firstPlayer = teamPlayers[0];
  const teamId = firstPlayer?.teamId ?? getPlayerTeam(gs, firstPlayer?.playerId);
  const teamPlayerIds = new Set(teamPlayers.map((p) => p.playerId));
  const halfSuitCards = buildHalfSuitMap(gs.variant).get(halfSuitId) ?? [];
  let count = 0;

  for (const card of halfSuitCards) {
    const holder = _getVisibleKnownHolder(gs, observerId, card);
    if (holder && holder !== '__conflict__' && teamPlayerIds.has(holder)) {
      count++;
      continue;
    }
    // Even when the exact holder is unknown, if all remaining candidates are
    // on this team the card is provably team-owned.
    if (!holder || holder === '__conflict__') {
      const knownTeam = _getVisibleKnownTeam(gs, observerId, card);
      if (knownTeam === teamId) {
        count++;
      }
    }
  }

  return count;
}

function _getVisibleOpponentHalfSuitCount(gs, observerId, teamPlayers, halfSuitId) {
  const teamPlayerIds = new Set(teamPlayers.map((p) => p.playerId));
  const halfSuitCards = buildHalfSuitMap(gs.variant).get(halfSuitId) ?? [];
  let count = 0;

  for (const card of halfSuitCards) {
    const holder = _getVisibleKnownHolder(gs, observerId, card);
    if (holder && holder !== '__conflict__' && !teamPlayerIds.has(holder)) {
      count++;
    }
  }

  return count;
}

function _getSuitCloseoutPriority(teamCount) {
  return teamCount >= TEAM_CLOSEOUT_PRIORITY_THRESHOLD ? teamCount : 0;
}

function _findKnownHolder(gs, observerId, cardId) {
  let holder = null;

  for (const player of gs.players) {
    if (_getEffectiveKnowledge(gs, observerId, player.playerId, cardId) !== true) continue;
    if (holder && holder !== player.playerId) return '__conflict__';
    holder = player.playerId;
  }

  return holder;
}

/**
 * Search for team-only assignments that are consistent with public information.
 *
 * Public constraints considered:
 *   - publicly visible total hand sizes
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
  const remainingTargetSlots = new Map(
    teamPlayers.map((p) => [p.playerId, _getVisibleTargetCapacity(gs, declarerId, p.playerId, halfSuitId)])
  );
  const assignment = {};

  function applyForced(card, playerId) {
    const existing = assignment[card];
    if (existing) return existing === playerId;
    if (!teamPlayerIds.has(playerId)) return false;
    if (_isKnownMissing(gs, declarerId, playerId, card)) return false;

    const remaining = remainingTargetSlots.get(playerId);
    if (remaining == null || remaining <= 0) return false;

    assignment[card] = playerId;
    remainingTargetSlots.set(playerId, remaining - 1);
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
    const knownHolder = _findKnownHolder(gs, declarerId, card);
    if (knownHolder === '__conflict__') return [];
    if (knownHolder && !applyForced(card, knownHolder)) {
      return [];
    }
  }

  const unassignedCards = cards.filter((card) => !assignment[card]);
  const remainingSlots = Array.from(remainingTargetSlots.values()).reduce((sum, n) => sum + n, 0);
  if (remainingSlots < unassignedCards.length) return [];

  const candidateMap = new Map();
  for (const card of unassignedCards) {
    const candidates = teamPlayers
      .map((p) => p.playerId)
      .filter((playerId) => remainingTargetSlots.get(playerId) > 0 && !_isKnownMissing(gs, declarerId, playerId, card));
    if (candidates.length === 0) return [];
    candidateMap.set(card, candidates);
  }

  const orderedCards = [...unassignedCards].sort((a, b) => {
    const diff = candidateMap.get(a).length - candidateMap.get(b).length;
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  const solutions = [];

  // Players publicly known to hold ≥1 card in this half-suit (they asked for
  // a card from it). Any valid solution must assign them at least one card.
  const mustHoldPlayerIds = new Set(
    teamPlayers
      .map((p) => p.playerId)
      .filter((pid) => _hasHalfSuitPresence(gs, pid, halfSuitId))
  );

  // Track how many cards each must-hold player has been assigned so far.
  // Pre-populated from forced assignments above.
  const mustHoldAssignCount = new Map();
  for (const pid of mustHoldPlayerIds) {
    const count = Object.values(assignment).filter((v) => v === pid).length;
    mustHoldAssignCount.set(pid, count);
  }

  function backtrack(index) {
    if (solutions.length >= maxSolutions) return;

    if (index >= orderedCards.length) {
      for (const pid of mustHoldPlayerIds) {
        if ((mustHoldAssignCount.get(pid) ?? 0) === 0) return;
      }
      solutions.push({ ...assignment });
      return;
    }

    const card = orderedCards[index];
    const candidates = candidateMap
      .get(card)
      .filter((playerId) => remainingTargetSlots.get(playerId) > 0)
      .sort((a, b) => {
        const diff = remainingTargetSlots.get(a) - remainingTargetSlots.get(b);
        return diff !== 0 ? diff : a.localeCompare(b);
      });

    for (const playerId of candidates) {
      assignment[card] = playerId;
      remainingTargetSlots.set(playerId, remainingTargetSlots.get(playerId) - 1);
      if (mustHoldPlayerIds.has(playerId)) {
        mustHoldAssignCount.set(playerId, (mustHoldAssignCount.get(playerId) ?? 0) + 1);
      }
      backtrack(index + 1);
      remainingTargetSlots.set(playerId, remainingTargetSlots.get(playerId) + 1);
      if (mustHoldPlayerIds.has(playerId)) {
        mustHoldAssignCount.set(playerId, (mustHoldAssignCount.get(playerId) ?? 0) - 1);
      }
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
  const remainingTargetSlots = new Map(
    teamPlayers.map((p) => [p.playerId, _getVisibleTargetCapacity(gs, declarerId, p.playerId, halfSuitId)])
  );

  function consumeSlot(playerId) {
    const remaining = remainingTargetSlots.get(playerId);
    if (remaining == null) return;
    remainingTargetSlots.set(playerId, Math.max(remaining - 1, 0));
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
    const knownHolder = _findKnownHolder(gs, declarerId, card);
    if (knownHolder && knownHolder !== '__conflict__' && teamPlayerIds.includes(knownHolder)) {
      assignment[card] = knownHolder;
      consumeSlot(knownHolder);
    }
  }

  for (const card of cards) {
    if (assignment[card]) continue;

    const candidates = teamPlayerIds.filter((playerId) => !_isKnownMissing(gs, declarerId, playerId, card));
    const safeCandidates = candidates.length > 0 ? candidates : teamPlayerIds;
    const preferred = safeCandidates.filter((playerId) => (remainingTargetSlots.get(playerId) ?? 0) > 0);
    const pool = preferred.length > 0 ? preferred : safeCandidates;

    const bestRemaining = Math.max(...pool.map((playerId) => remainingTargetSlots.get(playerId) ?? 0));
    const strongest = pool.filter((playerId) => (remainingTargetSlots.get(playerId) ?? 0) === bestRemaining);
    const assignee = strongest[Math.floor(Math.random() * strongest.length)];
    assignment[card] = assignee;
    consumeSlot(assignee);
  }

  return assignment;
}

function _findKnownHolderAsk(gs, askerId, validOpponents, candidateCards) {
  const shuffledOpps  = _shuffle([...validOpponents]);

  for (const card of candidateCards) {
    for (const opp of shuffledOpps) {
      if (_getEffectiveKnowledge(gs, askerId, opp.playerId, card) !== true) continue;
      const askVal = validateAsk(gs, askerId, opp.playerId, card);
      if (askVal.valid) {
        return { action: 'ask', targetId: opp.playerId, cardId: card };
      }
    }
  }

  return null;
}

function _isKnownEmptyInHalfSuit(gs, observerId, playerId, halfSuitId) {
  const halfSuitCards = buildHalfSuitMap(gs.variant).get(halfSuitId) ?? [];
  for (const card of halfSuitCards) {
    if (!_isKnownMissing(gs, observerId, playerId, card)) return false;
  }
  return true;
}

function _findUnknownAsk(gs, askerId, validOpponents, candidateCards) {
  const shuffledOpps  = _shuffle([...validOpponents]);

  for (const card of candidateCards) {
    const hsId = cardHalfSuit(gs, card);
    for (const opp of shuffledOpps) {
      if (_isKnownMissing(gs, askerId, opp.playerId, card)) continue;
      // Skip opponents known to hold nothing in this half-suit.
      if (hsId && _isKnownEmptyInHalfSuit(gs, askerId, opp.playerId, hsId)) continue;
      const askVal = validateAsk(gs, askerId, opp.playerId, card);
      if (askVal.valid) {
        return { action: 'ask', targetId: opp.playerId, cardId: card };
      }
    }
  }

  return null;
}

function _findSignalAsk(gs, askerId, validOpponents, candidateCards) {
  const shuffledOpps  = _shuffle([...validOpponents]);

  for (const card of candidateCards) {
    for (const opp of shuffledOpps) {
      const askVal = validateAsk(gs, askerId, opp.playerId, card);
      if (askVal.valid) {
        return { action: 'ask', targetId: opp.playerId, cardId: card };
      }
    }
  }

  return null;
}

function _getPublicTeamCardCandidateCount(gs, observerId, teamPlayers, cardId) {
  return teamPlayers.reduce(
    (sum, player) => sum + (_isKnownMissing(gs, observerId, player.playerId, cardId) ? 0 : 1),
    0
  );
}

function _getPreferredSignalCardId(gs, askerId, halfSuitId, currentMoveIndex) {
  const teamId = getPlayerTeam(gs, askerId);
  if (!teamId) return null;

  const entry = _getRecentTeammateSignalEntry(gs, askerId, teamId, halfSuitId, currentMoveIndex);
  if (!entry || entry.lastOutcome !== 'failure') return null;

  const focusCardId = entry.focusCardId;
  if (!focusCardId || cardHalfSuit(gs, focusCardId) !== halfSuitId) return null;
  if (getHand(gs, askerId).has(focusCardId)) return null;
  if (_getKnown(gs, askerId, focusCardId) === false) return null;

  return focusCardId;
}

function _scoreCardForAsk(gs, askerId, cardId, teamPlayers, validOpponents, preferredSignalCardId) {
  const publicTeamCandidates = _getPublicTeamCardCandidateCount(gs, askerId, teamPlayers, cardId);
  const publicOpponentCandidates = validOpponents.reduce(
    (sum, opp) => sum + (_isKnownMissing(gs, askerId, opp.playerId, cardId) ? 0 : 1),
    0
  );

  return {
    preferredSignal: cardId === preferredSignalCardId ? 1 : 0,
    askerPublicUnknown: _getKnown(gs, askerId, cardId) === null ? 1 : 0,
    resolutionStrength: Math.max(0, 6 - publicTeamCandidates),
    opponentSpecificity: publicOpponentCandidates > 0 ? Math.max(0, 6 - publicOpponentCandidates) : 0,
  };
}

function _orderCandidateCardsForHalfSuit(gs, askerId, halfSuitId, candidateCards, validOpponents, currentMoveIndex) {
  const teamId = getPlayerTeam(gs, askerId);
  if (!teamId) return [...candidateCards];

  const teamPlayers = getTeamPlayers(gs, teamId);
  const preferredSignalCardId = _getPreferredSignalCardId(
    gs,
    askerId,
    halfSuitId,
    currentMoveIndex
  );

  return [...candidateCards].sort((a, b) => {
    const aScore = _scoreCardForAsk(gs, askerId, a, teamPlayers, validOpponents, preferredSignalCardId);
    const bScore = _scoreCardForAsk(gs, askerId, b, teamPlayers, validOpponents, preferredSignalCardId);

    const preferredDiff = bScore.preferredSignal - aScore.preferredSignal;
    if (preferredDiff !== 0) return preferredDiff;

    const askerUnknownDiff = bScore.askerPublicUnknown - aScore.askerPublicUnknown;
    if (askerUnknownDiff !== 0) return askerUnknownDiff;

    const resolutionDiff = bScore.resolutionStrength - aScore.resolutionStrength;
    if (resolutionDiff !== 0) return resolutionDiff;

    const opponentDiff = bScore.opponentSpecificity - aScore.opponentSpecificity;
    if (opponentDiff !== 0) return opponentDiff;

    return a.localeCompare(b);
  });
}

function _findAskInHalfSuits(gs, askerId, validOpponents, halfSuitIds, halfSuitsMap) {
  const botHand = getHand(gs, askerId);
  const currentMoveIndex = (gs.moveHistory ?? []).length;

  for (const halfSuitId of halfSuitIds) {
    const cards = halfSuitsMap.get(halfSuitId) ?? [];
    const askableCards = cards.filter((card) => !botHand.has(card));
    const orderedCards = _orderCandidateCardsForHalfSuit(
      gs,
      askerId,
      halfSuitId,
      askableCards,
      validOpponents,
      currentMoveIndex
    );
    const preferredSignalCardId = _getPreferredSignalCardId(
      gs,
      askerId,
      halfSuitId,
      currentMoveIndex
    );

    if (preferredSignalCardId) {
      const preferredKnownAsk = _findKnownHolderAsk(gs, askerId, validOpponents, [preferredSignalCardId]);
      if (preferredKnownAsk) return preferredKnownAsk;

      const preferredUnknownAsk = _findUnknownAsk(gs, askerId, validOpponents, [preferredSignalCardId]);
      if (preferredUnknownAsk) return preferredUnknownAsk;

      const preferredSignalAsk = _findSignalAsk(gs, askerId, validOpponents, [preferredSignalCardId]);
      if (preferredSignalAsk) return preferredSignalAsk;
    }

    const remainingCards = orderedCards.filter((card) => card !== preferredSignalCardId);
    const knownAsk = _findKnownHolderAsk(gs, askerId, validOpponents, remainingCards);
    if (knownAsk) return knownAsk;

    const unknownAsk = _findUnknownAsk(gs, askerId, validOpponents, remainingCards);
    if (unknownAsk) return unknownAsk;
  }

  return null;
}

function _findSignalAskInHalfSuits(gs, askerId, validOpponents, halfSuitIds, halfSuitsMap) {
  const botHand = getHand(gs, askerId);
  const currentMoveIndex = (gs.moveHistory ?? []).length;

  for (const halfSuitId of halfSuitIds) {
    const cards = halfSuitsMap.get(halfSuitId) ?? [];
    const askableCards = cards.filter((c) => !botHand.has(c));
    const orderedCards = _orderCandidateCardsForHalfSuit(
      gs,
      askerId,
      halfSuitId,
      askableCards,
      validOpponents,
      currentMoveIndex
    );
    const signalAsk = _findSignalAsk(gs, askerId, validOpponents, orderedCards);
    if (signalAsk) return signalAsk;
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

    const opponentTeam = botTeam === 1 ? 2 : 1;
    const suitPriority = new Map(
      [...botHalfSuits].map((halfSuitId) => [
        halfSuitId,
        (() => {
          const teamCount = _getVisibleTeamHalfSuitCount(gs, botId, teamPlayers, halfSuitId);
          const opponentCount = _getVisibleOpponentHalfSuitCount(gs, botId, teamPlayers, halfSuitId);
          return {
            teammateAssistPriority: _getTeammateAssistPriority(
              gs,
              botId,
              botTeam,
              halfSuitId,
              teamCount,
              currentMoveIndex
            ),
            closeoutPriority: _getSuitCloseoutPriority(teamCount),
            // Opponents known to hold cards in a half-suit where the bot's
            // team also has cards — reclaiming these is urgent because the
            // opponent could declare first.
            opponentThreat: opponentCount,
            // Opponents actively asking about this suit — defend before they
            // collect enough info to declare it away from us.
            opponentAskThreat: _getTeamSignalStrength(gs, opponentTeam, halfSuitId, currentMoveIndex),
            signalStrength: _getTeamSignalStrength(gs, botTeam, halfSuitId, currentMoveIndex),
            teamCount,
          };
        })(),
      ])
    );
    const prioritizedBotHalfSuits = [...botHalfSuits].sort((a, b) => {
      const aPriority = suitPriority.get(a);
      const bPriority = suitPriority.get(b);
      const assistDiff = (bPriority?.teammateAssistPriority ?? 0) - (aPriority?.teammateAssistPriority ?? 0);
      if (assistDiff !== 0) return assistDiff;
      const closeoutDiff = (bPriority?.closeoutPriority ?? 0) - (aPriority?.closeoutPriority ?? 0);
      if (closeoutDiff !== 0) return closeoutDiff;
      // Defend suits opponents are actively asking about before they steal them.
      const askThreatDiff = (bPriority?.opponentAskThreat ?? 0) - (aPriority?.opponentAskThreat ?? 0);
      if (askThreatDiff !== 0) return askThreatDiff;
      // Prefer half-suits where opponents hold known cards — reclaim before
      // they can declare.
      const threatDiff = (bPriority?.opponentThreat ?? 0) - (aPriority?.opponentThreat ?? 0);
      if (threatDiff !== 0) return threatDiff;
      const signalDiff = (bPriority?.signalStrength ?? 0) - (aPriority?.signalStrength ?? 0);
      if (signalDiff !== 0) return signalDiff;
      const teamCountDiff = (bPriority?.teamCount ?? 0) - (aPriority?.teamCount ?? 0);
      if (teamCountDiff !== 0) return teamCountDiff;
      return a.localeCompare(b);
    });
    const focusHalfSuits = prioritizedBotHalfSuits.filter(
      (halfSuitId) => (suitPriority.get(halfSuitId)?.closeoutPriority ?? 0) > 0
    );

    // When the team is close to completing a suit, finish that chase before moving on.
    if (focusHalfSuits.length > 0) {
      const focusAsk = _findAskInHalfSuits(gs, botId, validOpponents, focusHalfSuits, halfSuitsMap);
      if (focusAsk) return focusAsk;
    }

    // Otherwise, or if closeout suits have no legal ask left, use the broader
    // suit-priority ordering.
    const generalAsk = _findAskInHalfSuits(gs, botId, validOpponents, prioritizedBotHalfSuits, halfSuitsMap);
    if (generalAsk) return generalAsk;

    // ── Priority 3: No ask found from prioritized search — keep old fallback shape ─
    const halfSuitScores = [];
    for (const halfSuitId of prioritizedBotHalfSuits) {
      if (isHalfSuitDeclared(gs, halfSuitId)) continue;
      const cards = halfSuitsMap.get(halfSuitId) ?? [];
      const priority = suitPriority.get(halfSuitId) ?? {
        teammateAssistPriority: 0,
        closeoutPriority: 0,
        opponentThreat: 0,
        opponentAskThreat: 0,
        signalStrength: 0,
        teamCount: 0,
      };

      // Cards in this suit not held by the bot = potentially askable
      const askableCards = cards.filter((c) => !getHand(gs, botId).has(c));

      if (askableCards.length > 0) {
        halfSuitScores.push({
          halfSuitId,
          teammateAssistPriority: priority.teammateAssistPriority,
          closeoutPriority: priority.closeoutPriority,
          opponentThreat: priority.opponentThreat,
          opponentAskThreat: priority.opponentAskThreat,
          signalStrength: priority.signalStrength,
          teamCount: priority.teamCount,
          askableCards,
        });
      }
    }

    halfSuitScores.sort((a, b) => {
      const assistDiff = b.teammateAssistPriority - a.teammateAssistPriority;
      if (assistDiff !== 0) return assistDiff;
      const closeoutDiff = b.closeoutPriority - a.closeoutPriority;
      if (closeoutDiff !== 0) return closeoutDiff;
      const askThreatDiff = b.opponentAskThreat - a.opponentAskThreat;
      if (askThreatDiff !== 0) return askThreatDiff;
      const threatDiff = b.opponentThreat - a.opponentThreat;
      if (threatDiff !== 0) return threatDiff;
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

    // If inference says every target is bad but opponents still have cards,
    // keep signaling instead of jumping to a speculative declaration.
    const signalAsk = _findSignalAskInHalfSuits(
      gs,
      botId,
      validOpponents,
      prioritizedBotHalfSuits,
      halfSuitsMap
    );
    if (signalAsk) return signalAsk;
  }

  // ── Fallback: only guess a declaration when no legal ask exists at all ───────
  // If opponents still have cards, prefer signaling asks over speculative
  // declarations so teammates get more public information first.
  if (validOpponents.length === 0) {
    const bestGuessDecl = _findBestGuessDeclaration(gs, botId, undeclaredHalfSuits, halfSuitsMap, teammates);
    if (bestGuessDecl) {
      return bestGuessDecl;
    }
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
  if (_getVisibleTeamHalfSuitCount(gs, botId, teamPlayers, halfSuitId) !== cards.length) {
    return null;
  }

  const solutions = _searchPublicAssignments(gs, botId, halfSuitId, cards, teamPlayers, {}, 2);
  if (solutions.length === 1) return solutions[0];
  // Team provably owns all 6 cards but exact assignment is ambiguous.
  // Declare with best-guess rather than wasting moves on signal asks.
  if (solutions.length > 1) {
    return _buildBestGuessAssignment(gs, botId, halfSuitId, cards, teamPlayers, {});
  }
  return null;
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
    const count = _getVisibleTeamHalfSuitCount(gs, botId, teamPlayers, halfSuitId);
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
