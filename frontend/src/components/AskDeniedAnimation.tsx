'use client';

import { useEffect } from 'react';
import type { CardId } from '@/types/game';
import PlayingCard from './PlayingCard';

export const ASK_DENIED_ANIMATION_MS = 2000;

const CARD_W = 72;
const CARD_H = 108;

export interface AskDeniedAnimationProps {
  cardId: CardId;
  seatLeft: number;
  seatTop: number;
  seatWidth: number;
  seatHeight: number;
  onComplete: () => void;
}

/**
 * AskDeniedAnimation
 *
 * Shows the requested card over the asked player's seat and flashes a bold
 * red X over their avatar area so the denial reads instantly without relying
 * on the last-move text.
 */
export default function AskDeniedAnimation({
  cardId,
  seatLeft,
  seatTop,
  seatWidth,
  seatHeight,
  onComplete,
}: AskDeniedAnimationProps) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onComplete();
    }, ASK_DENIED_ANIMATION_MS);
    return () => clearTimeout(timer);
  }, [onComplete]);

  const cardLeft = seatLeft + seatWidth / 2 - CARD_W / 2;
  const cardTop = seatTop + Math.max(4, seatHeight * 0.06);
  const cardCenterX = cardLeft + CARD_W / 2;
  const cardCenterY = cardTop + CARD_H / 2;
  const xSize = Math.max(42, Math.min(72, seatWidth * 0.62));

  return (
    <div
      className="fixed inset-0 z-50 pointer-events-none"
      aria-hidden="true"
      data-testid="ask-denied-animation"
    >
      <div
        className="absolute animate-ask-denied-card"
        style={{
          left: cardLeft,
          top: cardTop,
          width: CARD_W,
          height: CARD_H,
          animationDuration: `${ASK_DENIED_ANIMATION_MS}ms`,
        }}
        data-testid="ask-denied-card"
      >
        <PlayingCard
          cardId={cardId}
          size="xl"
          className="shadow-2xl shadow-rose-950/60"
        />
      </div>

      <div
        className="absolute"
        style={{
          left: cardCenterX,
          top: cardCenterY,
          transform: 'translate(-50%, -50%)',
        }}
        data-testid="ask-denied-x-anchor"
      >
        <span
          className="absolute left-1/2 top-1/2 animate-ask-denied-pulse rounded-full border-4 border-rose-400/30 bg-rose-500/5"
          style={{
            width: xSize,
            height: xSize,
            transform: 'translate(-50%, -50%)',
            animationDuration: `${ASK_DENIED_ANIMATION_MS}ms`,
          }}
        />
        <span
          className="relative block animate-ask-denied-x font-black leading-none text-rose-500/45 drop-shadow-[0_0_12px_rgba(244,63,94,0.28)]"
          style={{
            fontSize: `${xSize}px`,
            animationDuration: `${ASK_DENIED_ANIMATION_MS}ms`,
            textShadow: '0 0 6px rgba(255,255,255,0.18)',
          }}
          data-testid="ask-denied-x"
        >
          X
        </span>
      </div>
    </div>
  );
}
