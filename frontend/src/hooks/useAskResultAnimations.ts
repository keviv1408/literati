'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  SUIT_NAMES,
  parseCard,
  type AskResultPayload,
  type CardId,
  type CardRank,
} from '@/types/game';

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

export interface AskSpeechBubbleState {
  text: string;
  anchorX: number;
  anchorY: number;
  placement: 'above' | 'below';
}

const ASKER_BUBBLE_MS = 2000;

function getPlayerSeatElement(playerId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(`[data-player-id="${playerId}"]`);
}

function rankToWord(rank: CardRank): string {
  switch (rank) {
    case 1:
      return 'Ace';
    case 11:
      return 'Jack';
    case 12:
      return 'Queen';
    case 13:
      return 'King';
    default:
      return String(rank);
  }
}

function askBubbleText(cardId: CardId): string {
  const { rank, suit } = parseCard(cardId);
  return `Can I have the ${rankToWord(rank)} of ${SUIT_NAMES[suit].toLowerCase()}?`;
}

function buildAskSpeechBubble(
  playerRect: DOMRect,
  cardId: CardId,
): AskSpeechBubbleState {
  const placement = playerRect.top > 120 ? 'above' : 'below';
  return {
    text: askBubbleText(cardId),
    anchorX: playerRect.left + playerRect.width / 2,
    anchorY: placement === 'above' ? playerRect.top - 10 : playerRect.bottom + 10,
    placement,
  };
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
  const [askSpeechBubble, setAskSpeechBubble] = useState<AskSpeechBubbleState | null>(null);

  useEffect(() => {
    if (!lastAskResult) return;

    let bubbleTimer: ReturnType<typeof setTimeout> | null = null;
    const frameId = requestAnimationFrame(() => {
      const askerEl = getPlayerSeatElement(lastAskResult.askerId);
      if (askerEl) {
        setAskSpeechBubble(
          buildAskSpeechBubble(askerEl.getBoundingClientRect(), lastAskResult.cardId),
        );
        bubbleTimer = setTimeout(() => {
          setAskSpeechBubble(null);
        }, ASKER_BUBBLE_MS);
      } else {
        setAskSpeechBubble(null);
      }

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

    return () => {
      cancelAnimationFrame(frameId);
      if (bubbleTimer) clearTimeout(bubbleTimer);
    };
  }, [lastAskResult]);

  const clearCardFlight = useCallback(() => setCardFlight(null), []);
  const clearAskDeniedCue = useCallback(() => setAskDeniedCue(null), []);

  return {
    cardFlight,
    askDeniedCue,
    askSpeechBubble,
    clearCardFlight,
    clearAskDeniedCue,
  };
}
