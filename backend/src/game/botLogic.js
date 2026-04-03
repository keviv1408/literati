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

/**
 * Attach public-safe narration metadata to a bot ask decision.
 *
 * This is intentionally not literal chain-of-thought. It only carries the
 * high-level public reason bucket that led to the ask choice so the client can
 * render more expressive bot speech bubbles.
 *
 * @param {{ action: string }|null} move
 * @param {'known_holder'|'teammate_signal_followup'|'closeout_push'|'priority_guess'|'signal_probe'|'emergency_guess'} reason
 * @param {{ sourcePlayerId?: string, focusCardId?: string }} [extras]
 * @returns {typeof move}
 */
function _withBotAskNarration(move, reason, extras = {}) {
  if (!move || move.action !== 'ask') return move;

  const narration = { reason };
  if (typeof extras.sourcePlayerId === 'string') {
    narration.sourcePlayerId = extras.sourcePlayerId;
  }
  if (typeof extras.focusCardId === 'string') {
    narration.focusCardId = extras.focusCardId;
  }

  return {
    ...move,
    botAskNarration: narration,
  };
}

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
  // one card from. Track a public lower bound on how many cards each player
  // must currently hold in this half-suit.
  const hsId = cardHalfSuit(gs, cardId);
  if (hsId) {
    if (success) {
      const currentMinimum = _getHalfSuitPresenceCount(gs, askerId, hsId);
      // A successful ask proves the asker had at least one other card in the
      // suit before the transfer and now also holds the requested card.
      _markHalfSuitPresence(gs, askerId, hsId, Math.max(currentMinimum, 1) + 1);

      // A successful ask publicly removes one known card from the target's
      // hand. Any lower-bound evidence in this suit can safely decrease by one.
      _decrementHalfSuitPresence(gs, targetId, hsId);
    } else {
      _markHalfSuitPresence(gs, askerId, hsId, 1);
    }
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
    for (const entry of gs.botHalfSuitPresence.values()) {
      if (entry instanceof Set) {
        entry.delete(halfSuitId);
      } else if (entry instanceof Map) {
        entry.delete(halfSuitId);
      }
    }
  }

  if (!correct) return;
  // No additional holder information is needed here; the suit is out of play.
}

function _markHalfSuitPresence(gs, playerId, halfSuitId, minimumCount = 1) {
  const playerPresence = _getHalfSuitPresenceEntry(gs, playerId, true);
  if (!(playerPresence instanceof Map)) return;
  playerPresence.set(halfSuitId, Math.max(playerPresence.get(halfSuitId) ?? 0, minimumCount));
}

function _hasHalfSuitPresence(gs, playerId, halfSuitId) {
  return _getHalfSuitPresenceCount(gs, playerId, halfSuitId) > 0;
}

function _decrementHalfSuitPresence(gs, playerId, halfSuitId) {
  const playerPresence = _getHalfSuitPresenceEntry(gs, playerId);
  if (!(playerPresence instanceof Map)) return;

  const current = playerPresence.get(halfSuitId) ?? 0;
  if (current <= 1) {
    playerPresence.delete(halfSuitId);
    return;
  }

  playerPresence.set(halfSuitId, current - 1);
}

function _getHalfSuitPresenceCount(gs, playerId, halfSuitId) {
  const playerPresence = _getHalfSuitPresenceEntry(gs, playerId);
  if (playerPresence instanceof Map) {
    return playerPresence.get(halfSuitId) ?? 0;
  }
  return 0;
}

function _getHalfSuitPresenceEntry(gs, playerId, create = false) {
  if (!(gs.botHalfSuitPresence instanceof Map)) {
    if (!create) return null;
    gs.botHalfSuitPresence = new Map();
  }

  const existing = gs.botHalfSuitPresence.get(playerId);
  if (existing instanceof Map) return existing;

  if (existing instanceof Set) {
    const migrated = new Map([...existing].map((halfSuitId) => [halfSuitId, 1]));
    gs.botHalfSuitPresence.set(playerId, migrated);
    return migrated;
  }

  if (!create) return null;

  const created = new Map();
  gs.botHalfSuitPresence.set(playerId, created);
  return created;
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

function _getBlockingTeammateChases(gs, botId, currentMoveIndex = (gs.moveHistory ?? []).length) {
  const teamId = getPlayerTeam(gs, botId);
  if (!teamId) return [];

  const liveOpponents = gs.players.filter(
    (player) => player.teamId !== teamId && getCardCount(gs, player.playerId) > 0
  );
  if (liveOpponents.length === 0) return [];

  const chases = [];
  for (const halfSuitId of allHalfSuitIds()) {
    if (isHalfSuitDeclared(gs, halfSuitId)) continue;

    const entry = _getRecentTeammateSignalEntry(gs, botId, teamId, halfSuitId, currentMoveIndex);
    if (!entry?.sourcePlayerId) continue;
    if (getCardCount(gs, entry.sourcePlayerId) === 0) continue;

    const teammateMinimum = _getVisibleHalfSuitMinimumCount(
      gs,
      botId,
      entry.sourcePlayerId,
      halfSuitId
    );
    if (teammateMinimum < TEAM_CLOSEOUT_PRIORITY_THRESHOLD) continue;

    const blockedOpponentIds = liveOpponents
      .filter((player) => !_isKnownEmptyInHalfSuit(gs, botId, player.playerId, halfSuitId))
      .map((player) => player.playerId);
    if (blockedOpponentIds.length === 0) continue;

    chases.push({
      halfSuitId,
      teammateId: entry.sourcePlayerId,
      teammateMinimum,
      signalStrength: _effectiveSignalStrength(entry, currentMoveIndex),
      blockedOpponentIds,
    });
  }

  return chases.sort((a, b) => {
    const minimumDiff = b.teammateMinimum - a.teammateMinimum;
    if (minimumDiff !== 0) return minimumDiff;

    const signalDiff = b.signalStrength - a.signalStrength;
    if (signalDiff !== 0) return signalDiff;

    const blockedDiff = b.blockedOpponentIds.length - a.blockedOpponentIds.length;
    if (blockedDiff !== 0) return blockedDiff;

    const suitDiff = a.halfSuitId.localeCompare(b.halfSuitId);
    if (suitDiff !== 0) return suitDiff;

    return a.teammateId.localeCompare(b.teammateId);
  });
}

function _getBlockedOpponentIds(gs, botId, currentMoveIndex = (gs.moveHistory ?? []).length) {
  const blockedOpponentIds = new Set();

  for (const chase of _getBlockingTeammateChases(gs, botId, currentMoveIndex)) {
    for (const opponentId of chase.blockedOpponentIds) {
      blockedOpponentIds.add(opponentId);
    }
  }

  return blockedOpponentIds;
}

function _isBlockedAskTarget(gs, botId, targetId, currentMoveIndex = (gs.moveHistory ?? []).length) {
  return _getBlockedOpponentIds(gs, botId, currentMoveIndex).has(targetId);
}

function chooseBotPostDeclarationTurnPlayer(gs, botId) {
  const bestChase = _getBlockingTeammateChases(gs, botId)[0];
  return bestChase?.teammateId ?? null;
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
  const teamPlayerIdList = teamPlayers.map((p) => p.playerId);
  const remainingTargetSlots = new Map(
    teamPlayers.map((p) => [p.playerId, _getVisibleTargetCapacity(gs, declarerId, p.playerId, halfSuitId)])
  );
  const minimumRequiredCounts = new Map(
    teamPlayers.map((p) => [
      p.playerId,
      _getVisibleHalfSuitMinimumCount(gs, declarerId, p.playerId, halfSuitId),
    ])
  );
  const assignment = {};
  const assignedCounts = new Map(teamPlayers.map((p) => [p.playerId, 0]));

  if (Array.from(minimumRequiredCounts.values()).reduce((sum, count) => sum + count, 0) > cards.length) {
    return [];
  }

  for (const playerId of teamPlayerIdList) {
    if ((minimumRequiredCounts.get(playerId) ?? 0) > (remainingTargetSlots.get(playerId) ?? 0)) {
      return [];
    }
  }

  function applyForced(card, playerId) {
    const existing = assignment[card];
    if (existing) return existing === playerId;
    if (!teamPlayerIds.has(playerId)) return false;
    if (_isKnownMissing(gs, declarerId, playerId, card)) return false;

    const remaining = remainingTargetSlots.get(playerId);
    if (remaining == null || remaining <= 0) return false;

    assignment[card] = playerId;
    remainingTargetSlots.set(playerId, remaining - 1);
    assignedCounts.set(playerId, (assignedCounts.get(playerId) ?? 0) + 1);
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

  function backtrack(index) {
    if (solutions.length >= maxSolutions) return;

    const remainingCardsCount = orderedCards.length - index;
    const remainingMinimumNeed = teamPlayerIdList.reduce(
      (sum, playerId) => (
        sum + Math.max(0, (minimumRequiredCounts.get(playerId) ?? 0) - (assignedCounts.get(playerId) ?? 0))
      ),
      0
    );
    if (remainingMinimumNeed > remainingCardsCount) return;

    if (index >= orderedCards.length) {
      for (const playerId of teamPlayerIdList) {
        if ((assignedCounts.get(playerId) ?? 0) < (minimumRequiredCounts.get(playerId) ?? 0)) {
          return;
        }
      }
      solutions.push({ ...assignment });
      return;
    }

    const card = orderedCards[index];
    const candidates = candidateMap
      .get(card)
      .filter((playerId) => remainingTargetSlots.get(playerId) > 0)
      .sort((a, b) => {
        const aDeficit = Math.max(0, (minimumRequiredCounts.get(a) ?? 0) - (assignedCounts.get(a) ?? 0));
        const bDeficit = Math.max(0, (minimumRequiredCounts.get(b) ?? 0) - (assignedCounts.get(b) ?? 0));
        const deficitDiff = bDeficit - aDeficit;
        if (deficitDiff !== 0) return deficitDiff;

        const remainingDiff = remainingTargetSlots.get(a) - remainingTargetSlots.get(b);
        return remainingDiff !== 0 ? remainingDiff : a.localeCompare(b);
      });

    for (const playerId of candidates) {
      assignment[card] = playerId;
      remainingTargetSlots.set(playerId, remainingTargetSlots.get(playerId) - 1);
      assignedCounts.set(playerId, (assignedCounts.get(playerId) ?? 0) + 1);
      backtrack(index + 1);
      remainingTargetSlots.set(playerId, remainingTargetSlots.get(playerId) + 1);
      assignedCounts.set(playerId, (assignedCounts.get(playerId) ?? 0) - 1);
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
  for (const card of candidateCards) {
    const orderedOpponents = _orderOpponentsForCard(gs, askerId, validOpponents, card);
    for (const opp of orderedOpponents) {
      if (_getEffectiveKnowledge(gs, askerId, opp.playerId, card) !== true) continue;
      const askVal = validateAsk(gs, askerId, opp.playerId, card);
      if (askVal.valid) {
        return { action: 'ask', targetId: opp.playerId, cardId: card };
      }
    }
  }

  return null;
}

function _getVisibleKnownHalfSuitCardCount(gs, observerId, playerId, halfSuitId) {
  const halfSuitCards = buildHalfSuitMap(gs.variant).get(halfSuitId) ?? [];
  let count = 0;

  for (const card of halfSuitCards) {
    if (_getEffectiveKnowledge(gs, observerId, playerId, card) === true) {
      count++;
    }
  }

  return count;
}

function _getVisibleHalfSuitMinimumCount(gs, observerId, playerId, halfSuitId) {
  return Math.max(
    _getHalfSuitPresenceCount(gs, playerId, halfSuitId),
    _getVisibleKnownHalfSuitCardCount(gs, observerId, playerId, halfSuitId)
  );
}

function _getVisibleTeamHalfSuitMinimumCount(gs, observerId, teamPlayers, halfSuitId) {
  return teamPlayers.reduce(
    (sum, player) => sum + _getVisibleHalfSuitMinimumCount(gs, observerId, player.playerId, halfSuitId),
    0
  );
}

function _getRecentHalfSuitActivityStrength(gs, playerId, halfSuitId, currentMoveIndex) {
  const teamId = getPlayerTeam(gs, playerId);
  if (!teamId) return 0;

  const entry = _getTeamSignalEntry(gs, teamId, halfSuitId);
  if (!entry || entry.sourcePlayerId !== playerId) return 0;

  return _effectiveSignalStrength(entry, currentMoveIndex);
}

function _getOpponentAskPriority(gs, askerId, playerId, halfSuitId, currentMoveIndex) {
  return {
    knownSuitCards: _getVisibleKnownHalfSuitCardCount(gs, askerId, playerId, halfSuitId),
    recentActivity: _getRecentHalfSuitActivityStrength(gs, playerId, halfSuitId, currentMoveIndex),
    presence: _hasHalfSuitPresence(gs, playerId, halfSuitId) ? 1 : 0,
    capacity: _getVisibleTargetCapacity(gs, askerId, playerId, halfSuitId),
  };
}

function _compareOpponentAskPriority(a, b) {
  const knownSuitDiff = (b?.knownSuitCards ?? 0) - (a?.knownSuitCards ?? 0);
  if (knownSuitDiff !== 0) return knownSuitDiff;

  const recentActivityDiff = (b?.recentActivity ?? 0) - (a?.recentActivity ?? 0);
  if (recentActivityDiff !== 0) return recentActivityDiff;

  const presenceDiff = (b?.presence ?? 0) - (a?.presence ?? 0);
  if (presenceDiff !== 0) return presenceDiff;

  return (b?.capacity ?? 0) - (a?.capacity ?? 0);
}

function _orderOpponentsForCard(gs, askerId, validOpponents, cardId) {
  const halfSuitId = cardHalfSuit(gs, cardId);
  const shuffledOpponents = _shuffle([...validOpponents]);
  if (!halfSuitId) return shuffledOpponents;

  const currentMoveIndex = (gs.moveHistory ?? []).length;
  const blockedOpponentIds = _getBlockedOpponentIds(gs, askerId, currentMoveIndex);
  const baseOrder = new Map(
    shuffledOpponents.map((opponent, index) => [opponent.playerId, index])
  );
  const priorities = new Map(
    shuffledOpponents.map((opponent) => [
      opponent.playerId,
      _getOpponentAskPriority(gs, askerId, opponent.playerId, halfSuitId, currentMoveIndex),
    ])
  );

  return shuffledOpponents.sort((a, b) => {
    const blockingDiff =
      Number(blockedOpponentIds.has(a.playerId)) - Number(blockedOpponentIds.has(b.playerId));
    if (blockingDiff !== 0) return blockingDiff;

    const priorityDiff = _compareOpponentAskPriority(
      priorities.get(a.playerId),
      priorities.get(b.playerId)
    );
    if (priorityDiff !== 0) return priorityDiff;

    return (baseOrder.get(a.playerId) ?? 0) - (baseOrder.get(b.playerId) ?? 0);
  });
}

function _isKnownEmptyInHalfSuit(gs, observerId, playerId, halfSuitId) {
  const halfSuitCards = buildHalfSuitMap(gs.variant).get(halfSuitId) ?? [];
  for (const card of halfSuitCards) {
    if (!_isKnownMissing(gs, observerId, playerId, card)) return false;
  }
  return true;
}

function _findUnknownAsk(gs, askerId, validOpponents, candidateCards) {
  for (const card of candidateCards) {
    const hsId = cardHalfSuit(gs, card);
    const orderedOpponents = _orderOpponentsForCard(gs, askerId, validOpponents, card);
    for (const opp of orderedOpponents) {
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
  for (const card of candidateCards) {
    const orderedOpponents = _orderOpponentsForCard(gs, askerId, validOpponents, card);
    for (const opp of orderedOpponents) {
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
  const halfSuitId = cardHalfSuit(gs, cardId);
  const currentMoveIndex = (gs.moveHistory ?? []).length;
  let bestTargetPriority = null;
  let bestTargetBlockingRisk = 1;

  if (halfSuitId) {
    for (const opp of validOpponents) {
      if (_isKnownMissing(gs, askerId, opp.playerId, cardId)) continue;
      if (_isKnownEmptyInHalfSuit(gs, askerId, opp.playerId, halfSuitId)) continue;

      bestTargetBlockingRisk = Math.min(
        bestTargetBlockingRisk,
        _isBlockedAskTarget(gs, askerId, opp.playerId, currentMoveIndex) ? 1 : 0
      );

      const priority = _getOpponentAskPriority(
        gs,
        askerId,
        opp.playerId,
        halfSuitId,
        currentMoveIndex
      );
      if (!bestTargetPriority || _compareOpponentAskPriority(priority, bestTargetPriority) < 0) {
        bestTargetPriority = priority;
      }
    }
  }

  return {
    preferredSignal: cardId === preferredSignalCardId ? 1 : 0,
    bestTargetBlockingRisk,
    bestTargetKnownSuitCards: bestTargetPriority?.knownSuitCards ?? 0,
    bestTargetRecentActivity: bestTargetPriority?.recentActivity ?? 0,
    bestTargetPresence: bestTargetPriority?.presence ?? 0,
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

    const blockingDiff = aScore.bestTargetBlockingRisk - bScore.bestTargetBlockingRisk;
    if (blockingDiff !== 0) return blockingDiff;

    const targetKnownDiff = bScore.bestTargetKnownSuitCards - aScore.bestTargetKnownSuitCards;
    if (targetKnownDiff !== 0) return targetKnownDiff;

    const targetActivityDiff = bScore.bestTargetRecentActivity - aScore.bestTargetRecentActivity;
    if (targetActivityDiff !== 0) return targetActivityDiff;

    const targetPresenceDiff = bScore.bestTargetPresence - aScore.bestTargetPresence;
    if (targetPresenceDiff !== 0) return targetPresenceDiff;

    const askerUnknownDiff = bScore.askerPublicUnknown - aScore.askerPublicUnknown;
    if (askerUnknownDiff !== 0) return askerUnknownDiff;

    const resolutionDiff = bScore.resolutionStrength - aScore.resolutionStrength;
    if (resolutionDiff !== 0) return resolutionDiff;

    const opponentDiff = bScore.opponentSpecificity - aScore.opponentSpecificity;
    if (opponentDiff !== 0) return opponentDiff;

    return a.localeCompare(b);
  });
}

function _findAskInHalfSuits(
  gs,
  askerId,
  validOpponents,
  halfSuitIds,
  halfSuitsMap,
  options = {}
) {
  const botHand = getHand(gs, askerId);
  const currentMoveIndex = (gs.moveHistory ?? []).length;
  const fallbackUnknownReason = options.fallbackUnknownReason ?? 'priority_guess';

  for (const halfSuitId of halfSuitIds) {
    const cards = halfSuitsMap.get(halfSuitId) ?? [];
    const askableCards = cards.filter((card) => !botHand.has(card));
    const preferredSignalEntry = _getRecentTeammateSignalEntry(
      gs,
      askerId,
      getPlayerTeam(gs, askerId),
      halfSuitId,
      currentMoveIndex
    );
    const orderedCards = _orderCandidateCardsForHalfSuit(
      gs,
      askerId,
      halfSuitId,
      askableCards,
      validOpponents,
      currentMoveIndex
    );
    const preferredSignalCardId = _getPreferredSignalCardId(gs, askerId, halfSuitId, currentMoveIndex);

    if (preferredSignalCardId) {
      const signalNarrationExtras = {
        focusCardId: preferredSignalCardId,
        sourcePlayerId: preferredSignalEntry?.sourcePlayerId,
      };
      const preferredKnownAsk = _findKnownHolderAsk(gs, askerId, validOpponents, [preferredSignalCardId]);
      if (preferredKnownAsk) {
        return _withBotAskNarration(preferredKnownAsk, 'teammate_signal_followup', signalNarrationExtras);
      }

      const preferredUnknownAsk = _findUnknownAsk(gs, askerId, validOpponents, [preferredSignalCardId]);
      if (preferredUnknownAsk) {
        return _withBotAskNarration(preferredUnknownAsk, 'teammate_signal_followup', signalNarrationExtras);
      }

      const preferredSignalAsk = _findSignalAsk(gs, askerId, validOpponents, [preferredSignalCardId]);
      if (preferredSignalAsk) {
        return _withBotAskNarration(preferredSignalAsk, 'teammate_signal_followup', signalNarrationExtras);
      }
    }

    const remainingCards = orderedCards.filter((card) => card !== preferredSignalCardId);
    const knownAsk = _findKnownHolderAsk(gs, askerId, validOpponents, remainingCards);
    if (knownAsk) return _withBotAskNarration(knownAsk, 'known_holder');

    const unknownAsk = _findUnknownAsk(gs, askerId, validOpponents, remainingCards);
    if (unknownAsk) return _withBotAskNarration(unknownAsk, fallbackUnknownReason);
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
          const teamCount = Math.max(
            _getVisibleTeamHalfSuitCount(gs, botId, teamPlayers, halfSuitId),
            _getVisibleTeamHalfSuitMinimumCount(gs, botId, teamPlayers, halfSuitId)
          );
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
      const focusAsk = _findAskInHalfSuits(
        gs,
        botId,
        validOpponents,
        focusHalfSuits,
        halfSuitsMap,
        { fallbackUnknownReason: 'closeout_push' }
      );
      if (focusAsk) return focusAsk;
    }

    // Otherwise, or if closeout suits have no legal ask left, use the broader
    // suit-priority ordering.
    const generalAsk = _findAskInHalfSuits(
      gs,
      botId,
      validOpponents,
      prioritizedBotHalfSuits,
      halfSuitsMap,
      { fallbackUnknownReason: 'priority_guess' }
    );
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
      if (unknownAsk) {
        return _withBotAskNarration(
          unknownAsk,
          closeoutPriority > 0 ? 'closeout_push' : 'priority_guess'
        );
      }
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
    if (signalAsk) return _withBotAskNarration(signalAsk, 'signal_probe');
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

  // ── Emergency brute-force fallback ─────────────────────────────────────────
  // If ALL knowledge-filtered paths above returned null but opponents still
  // have cards, do a raw scan of every askable card × every valid opponent
  // ignoring all inference. This prevents stalling due to edge cases in the
  // knowledge system (e.g. exhausted knowledge maps, stale inference state).
  if (validOpponents.length > 0) {
    for (const hs of undeclaredHalfSuits) {
      const hsCards = halfSuitsMap.get(hs) ?? [];
      if (!hsCards.some((c) => getHand(gs, botId).has(c))) continue;
      for (const card of hsCards) {
        if (getHand(gs, botId).has(card)) continue;
        for (const opp of _orderOpponentsForCard(gs, botId, validOpponents, card)) {
          const askVal = validateAsk(gs, botId, opp.playerId, card);
          if (askVal.valid) {
            console.warn(
              `[bot] Emergency ask fallback: bot=${botId} room=${gs.roomCode} ` +
              `card=${card} target=${opp.playerId} (knowledge filters exhausted all options)`
            );
            return _withBotAskNarration(
              { action: 'ask', targetId: opp.playerId, cardId: card },
              'emergency_guess'
            );
          }
        }
      }
    }
  }

  // ── Emergency best-guess declaration fallback ───────────────────────────────
  // If there are truly no valid asks at all (all opponents have 0 cards, or the
  // bot has no cards left in undeclared suits), guess-declare the best suit.
  const emergencyDecl = _findBestGuessDeclaration(gs, botId, undeclaredHalfSuits, halfSuitsMap, teammates);
  if (emergencyDecl) {
    const emergencyValidation = validateDeclaration(gs, botId, emergencyDecl.halfSuitId, emergencyDecl.assignment);
    if (emergencyValidation.valid) {
      console.warn(
        `[bot] Emergency declare fallback: bot=${botId} room=${gs.roomCode} ` +
        `suit=${emergencyDecl.halfSuitId} (no valid ask found)`
      );
      return emergencyDecl;
    }
  }

  // Absolute fallback: should not reach here in a valid game state
  console.error(
    `[bot] Absolute pass fallback reached: bot=${botId} room=${gs.roomCode} ` +
    `validOpponents=${validOpponents.length} botHand=${[...getHand(gs, botId)].join(',')} ` +
    `undeclared=${undeclaredHalfSuits.join(',')}`
  );
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
  const exactTeamCount = _getVisibleTeamHalfSuitCount(gs, botId, teamPlayers, halfSuitId);
  const minimumTeamCount = _getVisibleTeamHalfSuitMinimumCount(gs, botId, teamPlayers, halfSuitId);
  if (Math.max(exactTeamCount, minimumTeamCount) !== cards.length) {
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
    const count = Math.max(
      _getVisibleTeamHalfSuitCount(gs, botId, teamPlayers, halfSuitId),
      _getVisibleTeamHalfSuitMinimumCount(gs, botId, teamPlayers, halfSuitId)
    );
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
  chooseBotPostDeclarationTurnPlayer,
  updateKnowledgeAfterAsk,
  updateKnowledgeAfterDeclaration,
  updateTeamIntentAfterAsk,
  updateTeamIntentAfterDeclaration,
};
