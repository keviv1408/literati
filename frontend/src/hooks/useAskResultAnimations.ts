'use client';

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import type { AskSpeechBubbleState } from '@/components/AskSpeechBubbleOverlay';
import type { AskResultPayload, CardId } from '@/types/game';

export interface CardFlightState {
  askerId: string;
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

export type { AskSpeechBubbleState };

const ASKER_BUBBLE_MS = 2400;

interface UseAskResultAnimationsOptions {
  getAskBubbleCardIds?: (lastAskResult: AskResultPayload) => CardId[] | undefined;
  getPlayerDisplayName?: (playerId: string) => string | undefined;
}

export function getPlayerSeatElement(playerId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(`.game-table-space [data-player-id="${playerId}"]`);
}

const BOT_ASK_BUBBLE_LEAD_INS = {
  known_holder: ['Locking in', 'Pretty sure'],
  teammate_signal_followup: ['Following clues', 'Reading signals'],
  closeout_push: ['Closing in', 'Pressing now'],
  priority_guess: ['Highly likely', 'Best guess'],
  signal_probe: ['Testing waters', 'Worth probing'],
  emergency_guess: ['Just guessing', 'Last resort'],
} as const;

function stableHash(input: string): number {
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function _botAskLeadIn(result: AskResultPayload): string {
  const narration = result.botAskNarration;
  if (!narration) return '';

  const templateKey = [
    result.askerId,
    result.targetId,
    result.cardId,
    narration.reason,
    narration.sourcePlayerId ?? '',
  ].join('|');

  const leadIns = BOT_ASK_BUBBLE_LEAD_INS[narration.reason];
  const leadIn = leadIns[stableHash(templateKey) % leadIns.length];
  return `${leadIn}. `;
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
  const readAskContext = useEffectEvent((result: AskResultPayload) => ({
    overrideBubbleCardIds: options.getAskBubbleCardIds?.(result),
    targetName: options.getPlayerDisplayName?.(result.targetId),
  }));
  const [shownResult, setShownResult] = useState<AskResultPayload | null>(null);
  const [cardFlight, setCardFlight] = useState<CardFlightState | null>(null);
  const [askDeniedCue, setAskDeniedCue] = useState<AskDeniedCueState | null>(null);
  const [askSpeechBubble, setAskSpeechBubble] = useState<AskSpeechBubbleState | null>(null);

  const batchStart = useRef<{ key: string; time: number } | null>(null);
  useEffect(() => {
    if (!lastAskResult) {
      batchStart.current = null;
      return;
    }

    const { overrideBubbleCardIds, targetName } = readAskContext(lastAskResult);
    const receivedAt = Date.now();
    let bubbleTimer: ReturnType<typeof setTimeout> | null = null;
    const frameId = requestAnimationFrame(() => {
      setShownResult(lastAskResult);
      const askerEl = getPlayerSeatElement(lastAskResult.askerId);
      if (askerEl) {
        const bubbleCardIds =
          overrideBubbleCardIds?.length
            ? overrideBubbleCardIds
            : lastAskResult.batchCardIds?.length
              ? lastAskResult.batchCardIds
              : [lastAskResult.cardId];
        const leadIn = bubbleCardIds.length === 1 && !lastAskResult.batchCardIds?.length
          ? _botAskLeadIn(lastAskResult)
          : '';
        const question = targetName ? `${targetName}, can I have the` : 'Can I have the';
        // A multi-card ask receives a separate result for each card.
        const batchKey = bubbleCardIds.length > 1
          ? JSON.stringify([lastAskResult.askerId, lastAskResult.targetId, ...bubbleCardIds])
          : null;
        if (!batchKey) {
          batchStart.current = null;
        } else if (batchStart.current?.key !== batchKey || lastAskResult.cardId === bubbleCardIds[0]) {
          batchStart.current = { key: batchKey, time: receivedAt };
        }
        const expiresAt = (batchStart.current?.time ?? receivedAt) + ASKER_BUBBLE_MS;
        const remaining = expiresAt - Date.now();
        if (remaining > 0) {
          setAskSpeechBubble({
            seat: askerEl, variant: 'ask', text: leadIn + question, cards: bubbleCardIds,
          });
          bubbleTimer = setTimeout(() => setAskSpeechBubble(null), remaining);
        } else {
          setAskSpeechBubble(null);
        }
      } else {
        setAskSpeechBubble(null);
      }

      if (lastAskResult.success) {
        const fromEl = getPlayerSeatElement(lastAskResult.targetId);
        const toEl = getPlayerSeatElement(lastAskResult.askerId);
        const table = fromEl?.closest('.game-table-space');
        if (!fromEl || !toEl || !table) {
          setCardFlight(null);
          setAskDeniedCue(null);
          return;
        }

        const bounds = table.getBoundingClientRect();
        const fromRect = fromEl.getBoundingClientRect();
        const toRect = toEl.getBoundingClientRect();
        setCardFlight({
          askerId: lastAskResult.askerId,
          cardId: lastAskResult.cardId,
          fromX: fromRect.left - bounds.left + fromRect.width / 2,
          fromY: fromRect.top - bounds.top + fromRect.height / 2,
          toX: toRect.left - bounds.left + toRect.width / 2,
          toY: toRect.top - bounds.top + toRect.height / 2,
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
    cardFlight: shownResult === lastAskResult ? cardFlight : null,
    askDeniedCue: shownResult === lastAskResult ? askDeniedCue : null,
    askSpeechBubble: shownResult === lastAskResult ? askSpeechBubble : null,
    clearCardFlight,
    clearAskDeniedCue,
  };
}
