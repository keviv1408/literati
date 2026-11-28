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
  askerId: string;
  targetId: string;
  cardId: CardId;
  seat: HTMLElement;
}

export type { AskSpeechBubbleState };

const ASKER_BUBBLE_MS = 2400;

interface UseAskResultAnimationsOptions {
  nextAskAnimation?: AskResultPayload | null;
  finishAskAnimation?: (result: AskResultPayload) => void;
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
  const { nextAskAnimation, finishAskAnimation } = options;
  const animationResult = nextAskAnimation === undefined ? lastAskResult : nextAskAnimation;
  const speechResult = nextAskAnimation ?? lastAskResult;
  const [visual, setVisual] = useState<{
    result: AskResultPayload;
    flight?: CardFlightState;
    denial?: AskDeniedCueState;
  } | null>(null);
  const [speech, setSpeech] = useState<{ result: AskResultPayload; bubble: AskSpeechBubbleState } | null>(null);

  const batchStart = useRef<{ key: string; time: number } | null>(null);
  useEffect(() => {
    if (!speechResult) {
      batchStart.current = null;
      return;
    }

    const { overrideBubbleCardIds, targetName } = readAskContext(speechResult);
    const receivedAt = Date.now();
    let bubbleTimer: ReturnType<typeof setTimeout> | undefined;
    const frameId = requestAnimationFrame(() => {
      const askerEl = getPlayerSeatElement(speechResult.askerId);
      if (askerEl) {
        const bubbleCardIds =
          overrideBubbleCardIds?.length
            ? overrideBubbleCardIds
            : speechResult.batchCardIds?.length
              ? speechResult.batchCardIds
              : [speechResult.cardId];
        const leadIn = bubbleCardIds.length === 1 && !speechResult.batchCardIds?.length
          ? _botAskLeadIn(speechResult)
          : '';
        const question = targetName ? `${targetName}, can I have the` : 'Can I have the';
        // A multi-card ask receives a separate result for each card.
        const batchKey = bubbleCardIds.length > 1
          ? JSON.stringify([speechResult.askerId, speechResult.targetId, ...bubbleCardIds])
          : null;
        if (!batchKey) {
          batchStart.current = null;
        } else if (batchStart.current?.key !== batchKey || speechResult.cardId === bubbleCardIds[0]) {
          batchStart.current = { key: batchKey, time: receivedAt };
        }
        const expiresAt = (batchStart.current?.time ?? receivedAt) + ASKER_BUBBLE_MS;
        const remaining = expiresAt - Date.now();
        if (remaining > 0) {
          setSpeech({
            result: speechResult,
            bubble: { seat: askerEl, variant: 'ask', text: leadIn + question, cards: bubbleCardIds },
          });
          bubbleTimer = setTimeout(() => setSpeech(null), remaining);
        } else {
          setSpeech(null);
        }
      } else {
        setSpeech(null);
      }
    });
    return () => {
      cancelAnimationFrame(frameId);
      clearTimeout(bubbleTimer);
    };
  }, [speechResult]);

  useEffect(() => {
    if (!animationResult) return;
    const frameId = requestAnimationFrame(() => {
      const fromEl = getPlayerSeatElement(animationResult.targetId);
      const toEl = getPlayerSeatElement(animationResult.askerId);
      const table = fromEl?.closest('.game-table-space');
      if (!fromEl || !toEl || !table) {
        finishAskAnimation?.(animationResult);
        return;
      }

      const { cardId, askerId, targetId } = animationResult;
      if (animationResult.success) {
        const fromRect = fromEl.getBoundingClientRect();
        const bounds = table.getBoundingClientRect();
        const toRect = toEl.getBoundingClientRect();
        setVisual({
          result: animationResult,
          flight: {
            askerId, cardId,
            fromX: fromRect.left - bounds.left + fromRect.width / 2,
            fromY: fromRect.top - bounds.top + fromRect.height / 2,
            toX: toRect.left - bounds.left + toRect.width / 2,
            toY: toRect.top - bounds.top + toRect.height / 2,
          },
        });
      } else {
        setVisual({
          result: animationResult,
          denial: { askerId, targetId, cardId, seat: fromEl },
        });
      }
    });
    return () => cancelAnimationFrame(frameId);
  }, [animationResult, finishAskAnimation]);

  const clearAnimation = useCallback(() => {
    if (!animationResult) return;
    setVisual(current => current?.result === animationResult ? null : current);
    finishAskAnimation?.(animationResult);
  }, [animationResult, finishAskAnimation]);

  return {
    cardFlight: visual?.result === animationResult ? visual.flight ?? null : null,
    askDeniedCue: visual?.result === animationResult ? visual.denial ?? null : null,
    askSpeechBubble: speech?.result === speechResult ? speech.bubble : null,
    speechResult,
    clearAskAnimation: clearAnimation,
  };
}
