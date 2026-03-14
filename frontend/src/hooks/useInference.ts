'use client';

/**
 * useInference — manages inference mode toggle and card probability computations.
 *
 * Inference mode is an optional overlay that shows the uniform-distribution
 * probability percentage for each unknown card / player when the local player
 * (or a spectator) activates it.
 *
 * ## What it provides
 *   - `inferenceActive`        : whether the probability overlay is currently on
 *   - `toggleInference`        : flip the mode on/off
 *   - `declaredCardIds`        : memoised Set of card IDs already removed from play
 *   - `getCardProbabilities`   : for a specific card → ProbabilityMap (playerId → %)
 *   - `getPlayerSharePercent`  : for a specific player → their bulk share % of unknowns
 *   - `getHalfSuitProbs`       : for a half-suit → per-card ProbabilityMap
 *
 * ## Usage
 * ```tsx
 * const { inferenceActive, toggleInference, getPlayerSharePercent } = useInference({
 *   myPlayerId, myHand, players,
 *   declaredSuits: gameState?.declaredSuits ?? [],
 *   variant,
 * });
 * ```
 *
 * The returned callbacks are memoised so that child components only re-render
 * when the underlying game state that drives probabilities actually changes.
 */

import { useState, useCallback, useMemo } from 'react';
import {
  getDeclaredCardIds,
  computeCardProbabilities,
  computePlayerSharePercent,
  computeHalfSuitProbabilities,
} from '@/utils/cardProbabilities';
import type { CardId, HalfSuitId, GamePlayer, DeclaredSuit } from '@/types/game';
import type { ProbabilityMap } from '@/utils/cardProbabilities';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UseInferenceOptions {
  /** Local player's ID; null for spectators. */
  myPlayerId: string | null;
  /** Cards in the local player's hand (empty for spectators). */
  myHand: CardId[];
  /** All players in the game with current card counts. */
  players: GamePlayer[];
  /** Half-suits that have already been declared. */
  declaredSuits: DeclaredSuit[];
  /** Deck variant — required to resolve half-suit card compositions. */
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s' | null;
}

export interface UseInferenceReturn {
  /** Whether the probability overlay is currently active. */
  inferenceActive: boolean;
  /** Toggle inference mode on / off. */
  toggleInference: () => void;
  /** Set of card IDs from declared suits (already removed from play). */
  declaredCardIds: Set<CardId>;
  /**
   * For a given card ID, return the probability (0–100%) that each
   * non-local player holds it.  Returns {} if the card is in myHand or
   * declared.
   */
  getCardProbabilities: (cardId: CardId) => ProbabilityMap;
  /**
   * For a given player, return their bulk share percentage of unknown cards.
   * Returns 0 for the local player (their cards are all known).
   */
  getPlayerSharePercent: (player: GamePlayer) => number;
  /**
   * For a given half-suit, return a per-card probability map.
   * Useful for the DeclareModal card-assignment step.
   */
  getHalfSuitProbs: (halfSuitId: HalfSuitId) => Record<CardId, ProbabilityMap>;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useInference({
  myPlayerId,
  myHand,
  players,
  declaredSuits,
  variant,
}: UseInferenceOptions): UseInferenceReturn {
  const [inferenceActive, setInferenceActive] = useState(false);

  const toggleInference = useCallback(() => {
    setInferenceActive((prev) => !prev);
  }, []);

  // Memoised set of declared card IDs — recomputed when declared suits change
  const declaredCardIds = useMemo<Set<CardId>>(() => {
    if (!variant) return new Set<CardId>();
    return getDeclaredCardIds(declaredSuits, variant);
  }, [declaredSuits, variant]);

  // Per-card probability map — stable callback, deps captured in closure
  const getCardProbabilities = useCallback(
    (cardId: CardId): ProbabilityMap => {
      return computeCardProbabilities(
        cardId,
        myPlayerId,
        myHand,
        players,
        declaredCardIds,
      );
    },
    [myPlayerId, myHand, players, declaredCardIds],
  );

  // Per-player share % — stable callback
  const getPlayerSharePercent = useCallback(
    (player: GamePlayer): number => {
      return computePlayerSharePercent(player, myPlayerId, players);
    },
    [myPlayerId, players],
  );

  // Per-half-suit probability map — stable callback
  const getHalfSuitProbs = useCallback(
    (halfSuitId: HalfSuitId): Record<CardId, ProbabilityMap> => {
      if (!variant) return {};
      return computeHalfSuitProbabilities(
        halfSuitId,
        variant,
        myPlayerId,
        myHand,
        players,
        declaredCardIds,
      );
    },
    [variant, myPlayerId, myHand, players, declaredCardIds],
  );

  return {
    inferenceActive,
    toggleInference,
    declaredCardIds,
    getCardProbabilities,
    getPlayerSharePercent,
    getHalfSuitProbs,
  };
}
