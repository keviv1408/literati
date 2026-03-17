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
 *   1. If the bot's team collectively (with certainty) holds all 6 cards of a
 *      half-suit, declare it.
 *   2. If the bot knows an opponent holds a specific card in a half-suit the
 *      bot already has cards from, ask that opponent for it.
 *   3. Otherwise, randomly ask any opponent for any card in a half-suit the
 *      bot holds, preferring half-suits with more friendly cards.
 *   4. If no valid ask is possible (all opponents empty), declare the
 *      best available half-suit with maximum known friendly cards.
 */

const { buildHalfSuitMap, buildCardToHalfSuitMap, allHalfSuitIds } = require('./halfSuits');
const { getHand, getCardCount, getPlayerTeam, getTeamPlayers, isHalfSuitDeclared, cardHalfSuit } = require('./gameState');
const { validateAsk, validateDeclaration } = require('./gameEngine');

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
  return _getKnown(gs, playerId, cardId) === false;
}

function _findKnownHolderAsk(gs, askerId, validOpponents, candidateCards) {
  const shuffledCards = _shuffle([...candidateCards]);
  const shuffledOpps  = _shuffle([...validOpponents]);

  for (const card of shuffledCards) {
    for (const opp of shuffledOpps) {
      if (_getKnown(gs, opp.playerId, card) !== true) continue;
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

    // For each half-suit the bot can ask from, look for known opponent cards
    for (const halfSuitId of botHalfSuits) {
      const cards = halfSuitsMap.get(halfSuitId) ?? [];
      const neededCards = cards.filter((card) => !botHand.has(card));
      const knownAsk = _findKnownHolderAsk(gs, botId, validOpponents, neededCards);
      if (knownAsk) return knownAsk;
    }

    // ── Priority 3: Random ask in a half-suit the bot has cards from ──────────
    // Prefer half-suits where the bot + teammates have more cards (closer to declaring)
    const halfSuitScores = [];
    for (const halfSuitId of botHalfSuits) {
      if (isHalfSuitDeclared(gs, halfSuitId)) continue;
      const cards = halfSuitsMap.get(halfSuitId) ?? [];

      // Count how many cards the bot's team holds in this half-suit
      const teamCount = cards.filter((c) => {
        const allTeam = [{ playerId: botId }, ...teammates];
        return allTeam.some((p) => getHand(gs, p.playerId).has(c));
      }).length;

      // Cards in this suit not held by the bot's team = potentially askable
      const askableCards = cards.filter((c) => !getHand(gs, botId).has(c));

      if (askableCards.length > 0) {
        halfSuitScores.push({ halfSuitId, teamCount, askableCards });
      }
    }

    // Sort by teamCount descending (prefer suits closer to completion)
    halfSuitScores.sort((a, b) => b.teamCount - a.teamCount);

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
  const cards    = halfSuitsMap.get(halfSuitId) ?? [];
  const teamPlayers = [{ playerId: botId }, ...teammates];

  const assignment = {};

  for (const card of cards) {
    let assignee = null;

    // First check exact knowledge from hand
    for (const p of teamPlayers) {
      if (getHand(gs, p.playerId).has(card)) {
        assignee = p.playerId;
        break;
      }
    }

    if (!assignee) {
      // Not held by any teammate we can see — can't declare with certainty
      return null;
    }

    assignment[card] = assignee;
  }

  return assignment;
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

  let bestSuit = null;
  let bestCount = -1;
  let bestAssignment = null;

  for (const halfSuitId of undeclaredHalfSuits) {
    const cards = halfSuitsMap.get(halfSuitId) ?? [];

    // Count how many cards the team holds
    let count = 0;
    const assignment = {};

    for (const card of cards) {
      for (const p of teamPlayers) {
        if (getHand(gs, p.playerId).has(card)) {
          assignment[card] = p.playerId;
          count++;
          break;
        }
      }
    }

    // Only consider half-suits where the team has at least 1 card
    if (count > 0 && count > bestCount) {
      bestCount  = count;
      bestSuit   = halfSuitId;

      // Fill missing cards with random teammates (best guess)
      const missingCards = cards.filter((c) => !(c in assignment));
      for (const card of missingCards) {
        // Assign to a random teammate (it'll probably be wrong, but we must declare)
        assignment[card] = teamPlayers[Math.floor(Math.random() * teamPlayers.length)].playerId;
      }
      bestAssignment = assignment;
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

  // Build a full assignment starting from the player's partial state.
  // For each unassigned card:
  //   1. Use actual hand data (authoritative) to assign to the holder.
  //   2. If no holder found in actual hands, assign to a random teammate (best guess).
  const fullAssignment = Object.assign({}, partialAssignment);

  for (const card of cards) {
    if (fullAssignment[card]) continue; // player already assigned this card

    // Check each teammate's actual hand
    let found = false;
    for (const p of teamPlayers) {
      if (getHand(gs, p.playerId).has(card)) {
        fullAssignment[card] = p.playerId;
        found = true;
        break;
      }
    }

    if (!found) {
      // Best guess: random teammate (may be wrong, but we must complete the assignment)
      fullAssignment[card] = teamPlayers[Math.floor(Math.random() * teamPlayers.length)].playerId;
    }
  }

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
};
