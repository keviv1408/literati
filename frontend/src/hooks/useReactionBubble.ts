'use client';

import { useEffect, useState } from 'react';
import type { AskSpeechBubbleState } from '@/components/AskSpeechBubbleOverlay';
import {
  buildAskSpeechBubble,
  getPlayerSeatElement,
} from '@/hooks/useAskResultAnimations';
import type { AskResultPayload, DeclarationResultPayload } from '@/types/game';
import { hashString } from '@/utils/avatar';

export const DENIED_REACTION_DELAY_MS = 1200;
export const REACTION_BUBBLE_MS = 2800;
// AskDeniedAnimation draws a 108px card from 4px below the seat top; keep the
// bubble clear of it when the seat sits in the bottom half of the screen.
const DENIED_CARD_REACH = 112;

const DENIED_LINES = ['Nope! 🙅', 'Not me 🤷', 'Wrong guess 😏', "Don't have it 🙈"];
const DECLARED_LINES = ['Declared! 🎉', 'Nailed it 🎯', 'Called it 🙌', 'Half-suit secured 🔥'];

// Keyed on the event so every client shows the same line.
function pickLine(lines: readonly string[], key: string): string {
  return lines[hashString(key) % lines.length];
}

/**
 * Reaction bubble for the player on the receiving end of a move: the asked
 * player after a failed ask, the declarer after a correct declaration.
 */
export function useReactionBubble(
  lastAskResult: AskResultPayload | null,
  lastDeclareResult: DeclarationResultPayload | null,
): AskSpeechBubbleState | null {
  const [bubble, setBubble] = useState<AskSpeechBubbleState | null>(null);

  useEffect(() => {
    if (!lastAskResult || lastAskResult.success) return;
    const { askerId, targetId, cardId } = lastAskResult;
    const text = pickLine(DENIED_LINES, `${askerId}|${targetId}|${cardId}`);

    const showTimer = setTimeout(() => {
      const seat = getPlayerSeatElement(targetId);
      if (!seat) return;
      const rect = seat.getBoundingClientRect();
      setBubble(
        buildAskSpeechBubble(
          {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            bottom: Math.max(rect.bottom, rect.top + DENIED_CARD_REACH),
          },
          text,
          'denied',
        ),
      );
    }, DENIED_REACTION_DELAY_MS);
    const hideTimer = setTimeout(
      () => setBubble(null),
      DENIED_REACTION_DELAY_MS + REACTION_BUBBLE_MS,
    );

    return () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
    };
  }, [lastAskResult]);

  useEffect(() => {
    if (!lastDeclareResult?.correct || lastDeclareResult.timedOut) return;
    const { declarerId, halfSuitId } = lastDeclareResult;
    const frameId = requestAnimationFrame(() => {
      const seat = getPlayerSeatElement(declarerId);
      if (!seat) return;
      setBubble(
        buildAskSpeechBubble(
          seat.getBoundingClientRect(),
          pickLine(DECLARED_LINES, `${declarerId}|${halfSuitId}`),
          'declared',
        ),
      );
    });
    const hideTimer = setTimeout(() => setBubble(null), REACTION_BUBBLE_MS);
    return () => {
      cancelAnimationFrame(frameId);
      clearTimeout(hideTimer);
    };
  }, [lastDeclareResult]);

  return bubble;
}
