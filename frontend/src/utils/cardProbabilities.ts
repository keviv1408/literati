/**
 * cardProbabilities.ts
 *
 * Pure utility functions for computing uniform-distribution card probability
 * percentages in the Literature game.
 *
 * ## Model
 * At any point during a game, we know:
 *   - `myHand`        : the exact cards the local player holds
 *   - `players`       : all players with their current `cardCount`
 *   - `declaredSuits` : half-suits that have been declared (cards removed)
 *   - `variant`       : which rank was removed from the deck (2, 7, or 8)
 *
 * For a card C that is **not in myHand** and **not in a declared suit**, we
 * do not know which of the other players holds it.  Under the uniform
 * distribution assumption, every card held by player X is equally likely to
 * be any specific unknown card.  Therefore:
 *
 *   P(player X holds card C) = X.cardCount / Σ_j cardCount_j   (j ≠ local player)
 *
 * This gives a fast, client-only approximation that improves as declarations
 * narrow the remaining card space.
 *
 * ## Exported API
 *   getDeclaredCardIds         – build the Set of removed card IDs
 *   computeCardProbabilities   – P(playerId → %) for one specific card
 *   computePlayerSharePercent  – overall % share of unknown cards for one player
 *   computeHalfSuitProbabilities – per-card, per-player % map for a full half-suit
 */

import { getHalfSuitCards } from '@/types/game';
import type { CardId, HalfSuitId, GamePlayer, DeclaredSuit } from '@/types/game';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Maps playerId → probability (integer 0–100). */
export type ProbabilityMap = Record<string, number>;

// ── getDeclaredCardIds ────────────────────────────────────────────────────────

/**
 * Build a Set of all card IDs that belong to already-declared half-suits.
 * These cards are permanently removed from the game and should be excluded
 * from probability calculations.
 */
export function getDeclaredCardIds(
  declaredSuits: DeclaredSuit[],
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s',
): Set<CardId> {
  const ids = new Set<CardId>();
  for (const ds of declaredSuits) {
    for (const cardId of getHalfSuitCards(ds.halfSuitId, variant)) {
      ids.add(cardId);
    }
  }
  return ids;
}

// ── computeCardProbabilities ──────────────────────────────────────────────────

/**
 * Compute the probability (0–100%) that each non-local player holds a
 * specific card, using the uniform-distribution model.
 *
 * Returns an empty object if:
 *   - the card is in `myHand` (we know we hold it)
 *   - the card is in a declared suit (removed from game)
 *   - all non-local players have 0 cards (no unknown holders)
 *
 * @param cardId         Card to compute probabilities for.
 * @param myPlayerId     Local player's ID (null for spectators).
 * @param myHand         Cards the local player holds.
 * @param players        Full player roster with current card counts.
 * @param declaredCardIds Set of card IDs from declared suits.
 */
export function computeCardProbabilities(
  cardId: CardId,
  myPlayerId: string | null,
  myHand: CardId[],
  players: GamePlayer[],
  declaredCardIds: Set<CardId>,
): ProbabilityMap {
  // Card is trivially placed — skip
  if (myHand.includes(cardId) || declaredCardIds.has(cardId)) {
    return {};
  }

  // Consider all players who might hold the card (exclude local player)
  const candidates = players.filter(
    (p) => p.playerId !== myPlayerId && p.cardCount > 0,
  );
  const total = candidates.reduce((sum, p) => sum + p.cardCount, 0);

  if (total === 0) return {};

  const result: ProbabilityMap = {};
  for (const player of candidates) {
    result[player.playerId] = Math.round((player.cardCount / total) * 100);
  }
  return result;
}

// ── computePlayerSharePercent ─────────────────────────────────────────────────

/**
 * Compute the percentage of unknown cards that a given player is expected to
 * hold under the uniform distribution.
 *
 * This is the player's "bulk share" and is used as the probability label on
 * player-seat chips in inference mode.
 *
 * Returns 0 for the local player (all their cards are known).
 *
 * @param player     The target player.
 * @param myPlayerId Local player's ID (null for spectators).
 * @param players    Full player roster with current card counts.
 */
export function computePlayerSharePercent(
  player: GamePlayer,
  myPlayerId: string | null,
  players: GamePlayer[],
): number {
  // The local player's own cards are fully known — no probability needed
  if (player.playerId === myPlayerId) return 0;

  const candidates = players.filter(
    (p) => p.playerId !== myPlayerId && p.cardCount > 0,
  );
  const total = candidates.reduce((sum, p) => sum + p.cardCount, 0);

  if (total === 0) return 0;
  return Math.round((player.cardCount / total) * 100);
}

// ── computeHalfSuitProbabilities ─────────────────────────────────────────────

/**
 * Compute per-card, per-player probability maps for every card in a half-suit.
 *
 * Useful for the DeclareModal where the player assigns each card to a
 * teammate — showing "XX% likely" hints based on card counts.
 *
 * @param halfSuitId    Half-suit to compute (e.g. "low_s").
 * @param variant       Deck variant.
 * @param myPlayerId    Local player's ID.
 * @param myHand        Cards the local player holds.
 * @param players       Full player roster.
 * @param declaredCardIds Set of card IDs from declared suits.
 *
 * @returns Map of cardId → ProbabilityMap (playerId → %).
 *          Cards in myHand have an empty ProbabilityMap (no need to guess).
 */
export function computeHalfSuitProbabilities(
  halfSuitId: HalfSuitId,
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s',
  myPlayerId: string | null,
  myHand: CardId[],
  players: GamePlayer[],
  declaredCardIds: Set<CardId>,
): Record<CardId, ProbabilityMap> {
  const cards = getHalfSuitCards(halfSuitId, variant);
  const result: Record<CardId, ProbabilityMap> = {};
  for (const cardId of cards) {
    result[cardId] = computeCardProbabilities(
      cardId,
      myPlayerId,
      myHand,
      players,
      declaredCardIds,
    );
  }
  return result;
}
