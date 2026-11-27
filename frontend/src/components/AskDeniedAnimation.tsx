'use client';

import { useEffect } from 'react';
import type { CardId } from '@/types/game';
import PlayingCard from './PlayingCard';

export const ASK_DENIED_ANIMATION_MS = 1250;

const CARD_W = 24;
const CARD_H = 36;

export interface AskDeniedAnimationProps {
  cardId: CardId;
  seatLeft: number;
  seatTop: number;
  seatWidth: number;
  seatHeight: number;
  onComplete: () => void;
}

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

  const left = Math.max(2, Math.min(window.innerWidth - CARD_W - 10, seatLeft + seatWidth - CARD_W));
  const top = Math.max(2, seatTop + Math.min(8, seatHeight * 0.08));
  return (
    <div className="fixed z-50 pointer-events-none" aria-hidden="true" data-testid="ask-denied-animation"
      style={{ left, top, width: CARD_W, height: CARD_H }}>
      <div data-testid="ask-denied-card" className="origin-top-left scale-50">
        <PlayingCard cardId={cardId} size="md" />
      </div>
      <span data-testid="ask-denied-x"
        className="absolute -bottom-1 -right-1 rounded-full bg-rose-800 px-1 text-xs font-bold leading-4 text-white">
        ×
      </span>
    </div>
  );
}
