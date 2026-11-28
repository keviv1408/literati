'use client';

import { useEffect, useEffectEvent } from 'react';
import type { AskDeniedCueState } from '@/hooks/useAskResultAnimations';
import PlayingCard from './PlayingCard';

export const ASK_DENIED_ANIMATION_MS = 1250;

export default function AskDeniedAnimation({ cue, onComplete }: {
  cue: AskDeniedCueState;
  onComplete: () => void;
}) {
  const finish = useEffectEvent(onComplete);
  useEffect(() => {
    const timer = setTimeout(finish, ASK_DENIED_ANIMATION_MS);
    return () => clearTimeout(timer);
  }, [cue]);

  return (
    <div className="absolute right-1 top-1 z-50 h-9 w-6 pointer-events-none" aria-hidden="true" data-testid="ask-denied-animation">
      <div data-testid="ask-denied-card" className="origin-top-left scale-50">
        <PlayingCard cardId={cue.cardId} size="md" />
      </div>
      <span data-testid="ask-denied-x"
        className="absolute -bottom-1 -right-1 rounded-full bg-rose-800 px-1 text-xs font-bold leading-4 text-white">
        ×
      </span>
    </div>
  );
}
