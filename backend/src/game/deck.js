'use strict';

/**
 * Deck utilities for the Literature (Literati) card game.
 *
 * Cards are represented as strings: "{rank}_{suit}"
 *   rank: 1 (Ace), 2-9, 10, 11 (Jack), 12 (Queen), 13 (King)
 *   suit: s (Spades), h (Hearts), d (Diamonds), c (Clubs)
 *
 * Examples:
 *   "1_s"  = Ace of Spades
 *   "13_d" = King of Diamonds
 *   "10_c" = 10 of Clubs
 *   "11_h" = Jack of Hearts
 */

const SUITS = ['s', 'h', 'd', 'c'];

// All 13 ranks
const ALL_RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

/** Rank removed for each variant */
const VARIANT_REMOVED_RANK = {
  remove_2s: 2,
  remove_7s: 7,
  remove_8s: 8,
};

/**
 * Build a card ID string from rank and suit.
 * @param {number} rank
 * @param {string} suit
 * @returns {string}
 */
function cardId(rank, suit) {
  return `${rank}_${suit}`;
}

/**
 * Parse a card ID string into { rank, suit }.
 * @param {string} id
 * @returns {{ rank: number, suit: string }}
 */
function parseCardId(id) {
  const [rankStr, suit] = id.split('_');
  return { rank: parseInt(rankStr, 10), suit };
}

/**
 * Human-readable label for a card.
 * @param {string} id
 * @returns {string}
 */
function cardLabel(id) {
  const { rank, suit } = parseCardId(id);
  const RANK_LABELS = {
    1: 'A', 10: '10', 11: 'J', 12: 'Q', 13: 'K',
  };
  const SUIT_LABELS = { s: '♠', h: '♥', d: '♦', c: '♣' };
  const rankStr = RANK_LABELS[rank] ?? String(rank);
  return `${rankStr}${SUIT_LABELS[suit]}`;
}

/**
 * Generate the 48-card Literature deck for the given variant.
 *
 * Each variant removes one rank (all 4 suits of that rank) from the
 * standard 52-card deck, leaving 48 cards = 8 half-suits × 6 cards.
 *
 * @param {'remove_2s'|'remove_7s'|'remove_8s'} variant
 * @returns {string[]} Array of 48 card ID strings.
 */
function buildDeck(variant) {
  const removedRank = VARIANT_REMOVED_RANK[variant];
  if (!removedRank) throw new Error(`Unknown variant: ${variant}`);

  const deck = [];
  for (const suit of SUITS) {
    for (const rank of ALL_RANKS) {
      if (rank !== removedRank) {
        deck.push(cardId(rank, suit));
      }
    }
  }
  return deck;
}

/**
 * Fisher-Yates shuffle (in-place, uses Math.random).
 * @param {string[]} arr
 * @returns {string[]} The same array, shuffled.
 */
function shuffleDeck(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Deal a shuffled 48-card deck evenly among players.
 *
 * 6 players → 8 cards each
 * 8 players → 6 cards each
 *
 * @param {string[]} deck - 48-card deck
 * @param {number} playerCount - 6 or 8
 * @returns {string[][]} Array of hands; hands[i] = cards for player i
 */
function dealCards(deck, playerCount) {
  const cardsPerPlayer = deck.length / playerCount;
  const hands = [];
  for (let i = 0; i < playerCount; i++) {
    hands.push(deck.slice(i * cardsPerPlayer, (i + 1) * cardsPerPlayer));
  }
  return hands;
}

module.exports = {
  SUITS,
  ALL_RANKS,
  VARIANT_REMOVED_RANK,
  cardId,
  parseCardId,
  cardLabel,
  buildDeck,
  shuffleDeck,
  dealCards,
};
