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

interface UseAskResultAnimationsOptions {
  getAskBubbleCardIds?: (lastAskResult: AskResultPayload) => CardId[] | undefined;
}

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

function formatNaturalList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function askBubbleTextForCards(cardIds: CardId[]): string {
  if (cardIds.length === 0) return 'Can I have that card?';
  if (cardIds.length === 1) return askBubbleText(cardIds[0]);

  const requestedCards = cardIds.map((cardId) => {
    const { rank, suit } = parseCard(cardId);
    return `${rankToWord(rank)} of ${SUIT_NAMES[suit].toLowerCase()}`;
  });

  return `Can I have the ${formatNaturalList(requestedCards)}?`;
}

function buildAskSpeechBubble(
  playerRect: DOMRect,
  cardIds: CardId[],
): AskSpeechBubbleState {
  const placement = playerRect.top > 120 ? 'above' : 'below';
  return {
    text: askBubbleTextForCards(cardIds),
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
export function useAskResultAnimations(
  lastAskResult: AskResultPayload | null,
  options: UseAskResultAnimationsOptions = {},
) {
  const getAskBubbleCardIds = options.getAskBubbleCardIds;
  const [cardFlight, setCardFlight] = useState<CardFlightState | null>(null);
  const [askDeniedCue, setAskDeniedCue] = useState<AskDeniedCueState | null>(null);
  const [askSpeechBubble, setAskSpeechBubble] = useState<AskSpeechBubbleState | null>(null);

  useEffect(() => {
    if (!lastAskResult) return;

    const overrideBubbleCardIds = getAskBubbleCardIds?.(lastAskResult);
    let bubbleTimer: ReturnType<typeof setTimeout> | null = null;
    const frameId = requestAnimationFrame(() => {
      const askerEl = getPlayerSeatElement(lastAskResult.askerId);
      if (askerEl) {
        const bubbleCardIds =
          overrideBubbleCardIds?.length
            ? overrideBubbleCardIds
            : lastAskResult.batchCardIds?.length
              ? lastAskResult.batchCardIds
              : [lastAskResult.cardId];
        setAskSpeechBubble(
          buildAskSpeechBubble(askerEl.getBoundingClientRect(), bubbleCardIds),
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
  }, [getAskBubbleCardIds, lastAskResult]);

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
