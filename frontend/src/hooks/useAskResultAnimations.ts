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

const ASKER_BUBBLE_MS = 3500;

interface UseAskResultAnimationsOptions {
  getAskBubbleCardIds?: (lastAskResult: AskResultPayload) => CardId[] | undefined;
  getPlayerDisplayName?: (playerId: string) => string | undefined;
  getPlayerBubblePlacement?: (playerId: string) => 'above' | 'below' | undefined;
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

function askBubbleText(cardId: CardId, askerName?: string): string {
  const { rank, suit } = parseCard(cardId);
  const prefix = askerName ? `${askerName}, c` : 'C';
  return `${prefix}an I have the ${rankToWord(rank)} of ${SUIT_NAMES[suit].toLowerCase()}?`;
}

function cardPhrase(cardId: CardId): string {
  const { rank, suit } = parseCard(cardId);
  return `${rankToWord(rank)} of ${SUIT_NAMES[suit].toLowerCase()}`;
}

function formatNaturalList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function askBubbleTextForCards(cardIds: CardId[], askerName?: string): string {
  if (cardIds.length === 0) return 'Can I have that card?';
  if (cardIds.length === 1) return askBubbleText(cardIds[0], askerName);

  const requestedCards = cardIds.map((cardId) => cardPhrase(cardId));

  const prefix = askerName ? `${askerName}, c` : 'C';
  return `${prefix}an I have the ${formatNaturalList(requestedCards)}?`;
}

const BOT_ASK_BUBBLE_TEMPLATES = {
  known_holder: [
    ({ askClause }: { askClause: string }) => `Alright, this one is pretty pinned down. ${askClause}`,
    ({ askClause }: { askClause: string }) => `The public trail is narrow here, so I'm leaning into it. ${askClause}`,
  ],
  teammate_signal_followup_with_source: [
    ({ askClause, sourceName }: { askClause: string, sourceName: string }) => `${sourceName} kept tugging at this suit, so I'm following that trail. ${askClause}`,
    ({ askClause, sourceName }: { askClause: string, sourceName: string }) => `${sourceName} put this suit back on the table for me, so I'm picking up the thread. ${askClause}`,
  ],
  teammate_signal_followup_without_source: [
    ({ askClause }: { askClause: string }) => `A recent ask put this suit back on my radar, so I'm chasing it. ${askClause}`,
    ({ askClause }: { askClause: string }) => `This suit has been making noise for a round or two, so I'm following up. ${askClause}`,
  ],
  closeout_push: [
    ({ askClause }: { askClause: string }) => `We're close to closing this half-suit, so I'm pressing the strongest lead I have. ${askClause}`,
    ({ askClause }: { askClause: string }) => `This suit is almost ready to lock up, so I'm pushing where the table points me. ${askClause}`,
  ],
  priority_guess: [
    ({ askClause }: { askClause: string }) => `This isn't certain, but public info points to you more than anyone else. ${askClause}`,
    ({ askClause }: { askClause: string }) => `I don't have a lock, but you're still the cleanest public bet. ${askClause}`,
  ],
  signal_probe: [
    ({ askClause }: { askClause: string }) => `I don't have a lock yet, so I'm probing the cleanest line in this suit. ${askClause}`,
    ({ askClause }: { askClause: string }) => `Nothing is confirmed here yet, so I'm testing the best public lead. ${askClause}`,
  ],
  emergency_guess: [
    ({ askClause }: { askClause: string }) => `Nothing is clean now, so I'm taking the safest gamble left. ${askClause}`,
    ({ askClause }: { askClause: string }) => `The table is muddy, so I'm taking the least risky shot I still have. ${askClause}`,
  ],
} as const;

function stableHash(input: string): number {
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function buildNarratedBotAskBubbleText(
  result: AskResultPayload,
  targetName?: string,
  sourceName?: string,
): string {
  const askClause = askBubbleText(result.cardId, targetName);
  const narration = result.botAskNarration;

  if (!narration) return askClause;

  const templateKey = [
    result.askerId,
    result.targetId,
    result.cardId,
    narration.reason,
    narration.sourcePlayerId ?? '',
  ].join('|');

  if (narration.reason === 'teammate_signal_followup') {
    if (sourceName) {
      const templates = BOT_ASK_BUBBLE_TEMPLATES.teammate_signal_followup_with_source;
      const template = templates[stableHash(templateKey) % templates.length];
      return template({ askClause, sourceName });
    }

    const templates = BOT_ASK_BUBBLE_TEMPLATES.teammate_signal_followup_without_source;
    const template = templates[stableHash(templateKey) % templates.length];
    return template({ askClause });
  }

  const templates = BOT_ASK_BUBBLE_TEMPLATES[narration.reason];
  const template = templates[stableHash(templateKey) % templates.length];
  return template({ askClause });
}

function buildAskSpeechBubble(
  playerRect: DOMRect,
  text: string,
  placementOverride?: 'above' | 'below',
): AskSpeechBubbleState {
  const placement = placementOverride ?? (playerRect.top > 120 ? 'above' : 'below');
  return {
    text,
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
  const getPlayerDisplayName = options.getPlayerDisplayName;
  const getPlayerBubblePlacement = options.getPlayerBubblePlacement;
  const [cardFlight, setCardFlight] = useState<CardFlightState | null>(null);
  const [askDeniedCue, setAskDeniedCue] = useState<AskDeniedCueState | null>(null);
  const [askSpeechBubble, setAskSpeechBubble] = useState<AskSpeechBubbleState | null>(null);

  useEffect(() => {
    if (!lastAskResult) return;

    const overrideBubbleCardIds = getAskBubbleCardIds?.(lastAskResult);
    const targetName = getPlayerDisplayName?.(lastAskResult.targetId);
    const placementOverride = getPlayerBubblePlacement?.(lastAskResult.askerId);
    const sourceName = lastAskResult.botAskNarration?.sourcePlayerId
      ? getPlayerDisplayName?.(lastAskResult.botAskNarration.sourcePlayerId)
      : undefined;
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
        const bubbleText =
          bubbleCardIds.length === 1 && !lastAskResult.batchCardIds?.length && lastAskResult.botAskNarration
            ? buildNarratedBotAskBubbleText(lastAskResult, targetName, sourceName)
            : askBubbleTextForCards(bubbleCardIds, targetName);
        setAskSpeechBubble(
          buildAskSpeechBubble(askerEl.getBoundingClientRect(), bubbleText, placementOverride),
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
  }, [getAskBubbleCardIds, getPlayerBubblePlacement, getPlayerDisplayName, lastAskResult]);

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
