'use client';

import { useEffect, useState } from 'react';
import { preload } from 'react-dom';
import { backUrl, deckUrl, isDeckReady, warmCardDeck } from '@/lib/cardDeck';

export function useCardDeck() {
  preload(backUrl, { as: 'image' });
  preload(deckUrl, { as: 'image' });
  const [canShowCards, setCanShowCards] = useState(isDeckReady);
  useEffect(() => {
    let active = true;
    // A slow connection must not cost someone a turn.
    const timeout = window.setTimeout(() => setCanShowCards(true), 2000);
    void warmCardDeck().then(() => {
      window.clearTimeout(timeout);
      if (active) setCanShowCards(true);
    });
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, []);
  return canShowCards;
}
