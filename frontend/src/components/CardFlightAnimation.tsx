'use client';

import { useEffect, useEffectEvent, type CSSProperties, type Ref } from 'react';
import type { CardId } from '@/types/game';
import PlayingCard from './PlayingCard';

export const FLIGHT_DURATION_MS = 2000;

export interface CardFlightAnimationProps {
  cardId: CardId;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  onComplete: () => void;
  cardRef?: Ref<HTMLDivElement>;
}

export default function CardFlightAnimation({
  cardId,
  fromX,
  fromY,
  toX,
  toY,
  onComplete,
  cardRef,
}: CardFlightAnimationProps) {
  const flightKey = [cardId, fromX, fromY, toX, toY].join(':');
  const complete = useEffectEvent(onComplete);
  useEffect(() => {
    const timer = setTimeout(complete, FLIGHT_DURATION_MS);
    return () => clearTimeout(timer);
  }, [flightKey]);

  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.hypot(dx, dy);
  const width = 48;
  const height = 72;
  const style = {
    left: fromX - width / 2,
    top: fromY - height / 2,
    width,
    height,
    '--flight-dx': `${dx}px`,
    '--flight-dy': `${dy}px`,
    '--flight-lean': `${distance ? 8 * dx / distance : 0}deg`,
    '--flight-pitch': `${distance ? -12 * dy / distance : 0}deg`,
    '--flight-lift': `${Math.min(44, distance * 0.2)}px`,
    animationDuration: `${FLIGHT_DURATION_MS}ms`,
  } as CSSProperties;

  return (
    <div
      className="absolute inset-0 z-40 pointer-events-none"
      aria-hidden="true"
      data-testid="card-flight-animation"
    >
      <div
        key={flightKey}
        ref={cardRef}
        className="absolute animate-card-flight-table"
        style={style}
        data-testid="card-flight-card"
      >
        <PlayingCard
          cardId={cardId}
          size="md"
          className="card-flight-face"
        />
      </div>
    </div>
  );
}
