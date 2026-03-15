/**
 * cardSort — hand auto-sort utilities for the Literature card game.
 *
 * The canonical display order groups cards by half-suit so players can quickly
 * locate related cards when deciding whether to ask or declare:
 *
 *   Low Spades → High Spades →
 *   Low Hearts  → High Hearts  →
 *   Low Diamonds→ High Diamonds→
 *   Low Clubs   → High Clubs
 *
 * Within each half-suit cards are ordered by ascending rank.
 *
 * The exact card membership of each half-suit depends on the card-removal
 * variant (remove_2s / remove_7s / remove_8s), which is why the sort
 * function accepts the variant parameter.
 */

import type { CardId, HalfSuitId } from '@/types/game';
import { parseCard, getCardHalfSuit } from '@/types/game';

export type CardVariant = 'remove_2s' | 'remove_7s' | 'remove_8s';

/**
 * Canonical half-suit display order.
 *
 * Suits cycle s → h → d → c; within each suit low precedes high so the
 * player sees low cards on the "left" and high cards on the "right" for
 * every suit group.
 */
export const HALF_SUIT_DISPLAY_ORDER: Record<HalfSuitId, number> = {
  low_s:  0,
  high_s: 1,
  low_h:  2,
  high_h: 3,
  low_d:  4,
  high_d: 5,
  low_c:  6,
  high_c: 7,
};

/**
 * Sort a player's hand by half-suit, then by rank within each half-suit.
 *
 * The sort is stable with respect to equal-ranked cards (which cannot occur
 * in a valid deck but is handled gracefully by returning 0).
 *
 * @param hand    Array of card ID strings e.g. ["1_s", "9_h", "13_d"].
 * @param variant Card-removal variant used to compute half-suit membership.
 * @returns       A new sorted array — the original `hand` array is not mutated.
 */
export function sortHandByHalfSuit(hand: CardId[], variant: CardVariant): CardId[] {
  return [...hand].sort((a, b) => {
    const hsA = getCardHalfSuit(a, variant);
    const hsB = getCardHalfSuit(b, variant);

    // Half-suit bucket comparison — unknown half-suits sort to the end
    const orderA = hsA !== null ? (HALF_SUIT_DISPLAY_ORDER[hsA] ?? 99) : 99;
    const orderB = hsB !== null ? (HALF_SUIT_DISPLAY_ORDER[hsB] ?? 99) : 99;

    if (orderA !== orderB) return orderA - orderB;

    // Within the same half-suit sort by ascending rank
    return parseCard(a).rank - parseCard(b).rank;
  });
}
