'use strict';

/**
 * Half-suit definitions for the Literature card game.
 *
 * Each variant produces 8 half-suits of 6 cards each (48 cards total).
 *
 * Half-suit IDs follow the pattern: "{low|high}_{suit}"
 *   e.g. "low_s" = low spades, "high_d" = high diamonds
 *
 * Tiebreaker: "high_d" (high diamonds) is the decisive half-suit.
 */

const { cardId, SUITS } = require('./deck');

// ---------------------------------------------------------------------------
// Suit label helpers
// ---------------------------------------------------------------------------

const SUIT_LABELS = { s: 'Spades', h: 'Hearts', d: 'Diamonds', c: 'Clubs' };

/**
 * Generate half-suit card lists for a given removed rank.
 *
 * Logic:
 *   - Build the 12 remaining ranks for the suit.
 *   - Sort them in natural order.
 *   - Split into two groups of 6: low (bottom 6) and high (top 6).
 *
 * @param {'remove_2s'|'remove_7s'|'remove_8s'} variant
 * @returns {Map<string, string[]>} halfSuitId → array of 6 card IDs
 */
function buildHalfSuitMap(variant) {
  const RANK_REMOVED = {
    remove_2s: 2,
    remove_7s: 7,
    remove_8s: 8,
  };
  const removed = RANK_REMOVED[variant];
  if (removed === undefined) throw new Error(`Unknown variant: ${variant}`);

  const ALL_RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  const remainingRanks = ALL_RANKS.filter((r) => r !== removed);
  // remainingRanks has 12 elements; sorted ascending already.

  const lowRanks  = remainingRanks.slice(0, 6);  // bottom 6
  const highRanks = remainingRanks.slice(6, 12); // top 6

  /** @type {Map<string, string[]>} */
  const map = new Map();

  for (const suit of SUITS) {
    map.set(`low_${suit}`,  lowRanks.map((r) => cardId(r, suit)));
    map.set(`high_${suit}`, highRanks.map((r) => cardId(r, suit)));
  }

  return map;
}

/**
 * Reverse lookup: given a card ID, return its half-suit ID for the variant.
 *
 * @param {'remove_2s'|'remove_7s'|'remove_8s'} variant
 * @returns {Map<string, string>} cardId → halfSuitId
 */
function buildCardToHalfSuitMap(variant) {
  const halfSuits = buildHalfSuitMap(variant);
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const [hsId, cards] of halfSuits) {
    for (const card of cards) {
      map.set(card, hsId);
    }
  }
  return map;
}

/**
 * Return the half-suit ID for a given card in a given variant.
 *
 * @param {string} card  - card ID string (e.g. "3_s")
 * @param {'remove_2s'|'remove_7s'|'remove_8s'} variant
 * @returns {string}  - half-suit ID (e.g. "low_s")
 */
function getHalfSuitId(card, variant) {
  const map = buildCardToHalfSuitMap(variant);
  const id = map.get(card);
  if (!id) throw new Error(`Card ${card} not found for variant ${variant}`);
  return id;
}

/**
 * Human-readable label for a half-suit.
 *
 * @param {string} halfSuitId  - e.g. "low_s", "high_d"
 * @returns {string}  - e.g. "Low Spades", "High Diamonds"
 */
function halfSuitLabel(halfSuitId) {
  const [tier, suit] = halfSuitId.split('_');
  const tierStr = tier.charAt(0).toUpperCase() + tier.slice(1);
  return `${tierStr} ${SUIT_LABELS[suit] ?? suit}`;
}

/**
 * All 8 half-suit IDs in a stable order.
 * @returns {string[]}
 */
function allHalfSuitIds() {
  const ids = [];
  for (const tier of ['low', 'high']) {
    for (const suit of SUITS) {
      ids.push(`${tier}_${suit}`);
    }
  }
  return ids;
}

/**
 * The tiebreaker half-suit ID — always "high_d" (high diamonds).
 * After all 8 half-suits are declared, if the score is tied 4-4,
 * the team that declared this half-suit wins.
 */
const TIEBREAKER_HALF_SUIT = 'high_d';

module.exports = {
  buildHalfSuitMap,
  buildCardToHalfSuitMap,
  getHalfSuitId,
  halfSuitLabel,
  allHalfSuitIds,
  TIEBREAKER_HALF_SUIT,
  SUIT_LABELS,
};
