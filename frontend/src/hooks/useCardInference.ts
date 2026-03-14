'use client';

/**
 * useCardInference — derives card-location knowledge from public game events.
 *
 * Since Literature is a perfect-information game in the long run (all card
 * locations become known through ask/declare events), spectators and players
 * can build up a partial inference map from the public broadcast stream.
 *
 * ### Rules applied
 * | Event                         | Inference                                      |
 * |-------------------------------|------------------------------------------------|
 * | ask_result (success=true)     | askerId confirmed-has cardId                   |
 * |                               | targetId confirmed-not cardId                  |
 * | ask_result (success=false)    | targetId confirmed-not cardId                  |
 * | declaration_result            | Each card in assignment confirmed for playerId |
 * |                               | Declared cards removed from all players' maps  |
 *
 * ### Resetting
 * The caller can call `resetInferences()` to clear all state (e.g. on
 * game restart or rematch).
 *
 * @example
 * const { cardInferences, resetInferences } = useCardInference({
 *   lastAskResult,
 *   lastDeclareResult,
 *   variant,
 * });
 *
 * // Per-player inference (for SpectatorInferencePanel or seat indicator)
 * const aliceInference = cardInferences['player-alice'] ?? {};
 * const confirmed = Object.values(aliceInference).filter(v => v === 'confirmed').length;
 */

import { useState, useEffect, useCallback } from 'react';
import type { AskResultPayload, DeclarationResultPayload } from '@/types/game';
import { getHalfSuitCards } from '@/types/game';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Confidence level for a specific (player, card) pair based on public events.
 *
 * - `'confirmed'` — the player is known to hold this card (from a successful ask
 *   or a declaration that correctly identified the card location).
 * - `'excluded'`  — the player is known NOT to hold this card (from a failed ask
 *   against them).
 */
export type CardConfidence = 'confirmed' | 'excluded';

/**
 * Per-card inference map for a single player.
 * Keys are CardId strings (e.g. "5_h"); only known/excluded entries are present.
 * Absence of a key means "unknown".
 */
export type PlayerInference = Record<string, CardConfidence>;

/**
 * Full inference state across all players.
 * Keys are playerId strings.
 */
export type CardInferenceState = Record<string, PlayerInference>;

// ── Hook options ──────────────────────────────────────────────────────────────

export interface UseCardInferenceOptions {
  /** Most recent ask result from the game socket (null until first ask). */
  lastAskResult: AskResultPayload | null;

  /** Most recent declaration result from the game socket (null until first declare). */
  lastDeclareResult: DeclarationResultPayload | null;

  /** Card removal variant — needed to compute which cards belong to each half-suit. */
  variant: 'remove_2s' | 'remove_7s' | 'remove_8s' | null;
}

// ── Hook return ───────────────────────────────────────────────────────────────

export interface UseCardInferenceReturn {
  /**
   * The current inference map: `{ [playerId]: { [cardId]: 'confirmed'|'excluded' } }`.
   * Updated reactively whenever `lastAskResult` or `lastDeclareResult` changes.
   */
  cardInferences: CardInferenceState;

  /**
   * Reset the entire inference map back to an empty state.
   * Should be called when a new game starts (e.g. rematch).
   */
  resetInferences: () => void;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Tracks per-(player, card) inference data from public game events.
 *
 * The hook is stateful: each new `lastAskResult` or `lastDeclareResult` value
 * is applied as a delta onto the accumulated inference map.
 */
export function useCardInference({
  lastAskResult,
  lastDeclareResult,
  variant,
}: UseCardInferenceOptions): UseCardInferenceReturn {
  const [cardInferences, setCardInferences] = useState<CardInferenceState>({});

  // ── Reset helper ────────────────────────────────────────────────────────────
  const resetInferences = useCallback(() => {
    setCardInferences({});
  }, []);

  // ── Ask result → update inference ──────────────────────────────────────────
  useEffect(() => {
    if (!lastAskResult) return;

    const { askerId, targetId, cardId, success } = lastAskResult;

    setCardInferences((prev) => {
      const next = deepCopy(prev);

      if (success) {
        // Asker confirmed to now hold the card
        setPlayerCard(next, askerId, cardId, 'confirmed');
        // Target confirmed to no longer hold the card
        setPlayerCard(next, targetId, cardId, 'excluded');
      } else {
        // Target confirmed NOT to hold the card
        setPlayerCard(next, targetId, cardId, 'excluded');
      }

      return next;
    });
  }, [lastAskResult]);

  // ── Declaration result → update inference ─────────────────────────────────
  useEffect(() => {
    if (!lastDeclareResult || !variant) return;

    const { halfSuitId, assignment } = lastDeclareResult;
    const halfSuitCards = getHalfSuitCards(halfSuitId, variant);

    setCardInferences((prev) => {
      const next = deepCopy(prev);

      // Apply confirmed card locations from the declaration assignment
      for (const [cardId, playerId] of Object.entries(assignment)) {
        setPlayerCard(next, playerId, cardId, 'confirmed');
      }

      // Remove all declared cards from all players' inference maps
      // — they are now out of play so probability tracking is irrelevant.
      for (const playerId of Object.keys(next)) {
        for (const cardId of halfSuitCards) {
          delete next[playerId][cardId];
        }
      }

      return next;
    });
  }, [lastDeclareResult, variant]);

  return { cardInferences, resetInferences };
}

// ── Private helpers ──────────────────────────────────────────────────────────

/** Shallow-copy top-level + each nested player map to ensure referential change. */
function deepCopy(state: CardInferenceState): CardInferenceState {
  const copy: CardInferenceState = {};
  for (const [playerId, playerMap] of Object.entries(state)) {
    copy[playerId] = { ...playerMap };
  }
  return copy;
}

/** Set a card confidence for a player, creating nested objects as needed. */
function setPlayerCard(
  state: CardInferenceState,
  playerId: string,
  cardId: string,
  confidence: CardConfidence,
): void {
  if (!state[playerId]) state[playerId] = {};
  state[playerId][cardId] = confidence;
}
