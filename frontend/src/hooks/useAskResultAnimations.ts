'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AskResultPayload, CardId } from '@/types/game';

export interface CardFlightState {
  cardId: CardId;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

export interface AskDeniedCueState {
  cardId: CardId;
  seatLeft: number;
  seatTop: number;
  seatWidth: number;
  seatHeight: number;
}

function getPlayerSeatElement(playerId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(`[data-player-id="${playerId}"]`);
}

/**
 * Derives ask-result visual overlays from the live `ask_result` payload.
 *
 * Successful asks produce a card-flight from target → asker.
 * Denied asks produce a temporary denial cue over the asked player's seat.
 */
export function useAskResultAnimations(lastAskResult: AskResultPayload | null) {
  const [cardFlight, setCardFlight] = useState<CardFlightState | null>(null);
  const [askDeniedCue, setAskDeniedCue] = useState<AskDeniedCueState | null>(null);

  useEffect(() => {
    if (!lastAskResult) return;

    const frameId = requestAnimationFrame(() => {
      if (lastAskResult.success) {
        const fromEl = getPlayerSeatElement(lastAskResult.targetId);
        const toEl = getPlayerSeatElement(lastAskResult.askerId);
        if (!fromEl || !toEl) {
          setCardFlight(null);
          setAskDeniedCue(null);
          return;
        }

        const fromRect = fromEl.getBoundingClientRect();
        const toRect = toEl.getBoundingClientRect();
        setCardFlight({
          cardId: lastAskResult.cardId,
          fromX: fromRect.left + fromRect.width / 2,
          fromY: fromRect.top + fromRect.height / 2,
          toX: toRect.left + toRect.width / 2,
          toY: toRect.top + toRect.height / 2,
        });
        setAskDeniedCue(null);
        return;
      }

      const targetEl = getPlayerSeatElement(lastAskResult.targetId);
      if (!targetEl) {
        setCardFlight(null);
        setAskDeniedCue(null);
        return;
      }

      const targetRect = targetEl.getBoundingClientRect();
      setCardFlight(null);
      setAskDeniedCue({
        cardId: lastAskResult.cardId,
        seatLeft: targetRect.left,
        seatTop: targetRect.top,
        seatWidth: targetRect.width,
        seatHeight: targetRect.height,
      });
    });

    return () => cancelAnimationFrame(frameId);
  }, [lastAskResult]);

  const clearCardFlight = useCallback(() => setCardFlight(null), []);
  const clearAskDeniedCue = useCallback(() => setAskDeniedCue(null), []);

  return {
    cardFlight,
    askDeniedCue,
    clearCardFlight,
    clearAskDeniedCue,
  };
}
