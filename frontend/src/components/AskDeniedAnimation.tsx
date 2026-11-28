'use client';

import { useEffect, useEffectEvent, useLayoutEffect, useRef } from 'react';
import type { AskDeniedCueState } from '@/hooks/useAskResultAnimations';
import PlayingCard from './PlayingCard';

export const ASK_DENIED_ANIMATION_MS = 1250;
const GAP = 6;

function _overlap(left: number, top: number, width: number, height: number, rect: DOMRect) {
  return Math.max(0, Math.min(left + width, rect.right) - Math.max(left, rect.left)) *
    Math.max(0, Math.min(top + height, rect.bottom) - Math.max(top, rect.top));
}

export default function AskDeniedAnimation({ cue, onComplete }: {
  cue: AskDeniedCueState;
  onComplete: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const finish = useEffectEvent(onComplete);
  useEffect(() => {
    const timer = setTimeout(finish, ASK_DENIED_ANIMATION_MS);
    return () => clearTimeout(timer);
  }, [cue]);

  useLayoutEffect(() => {
    const card = cardRef.current;
    const table = cue.seat.closest<HTMLElement>('.game-table-space');
    if (!card || !table) return;

    const position = () => {
      const bounds = table.getBoundingClientRect();
      const seat = cue.seat.getBoundingClientRect();
      const { width, height } = card.getBoundingClientRect();
      const x = seat.left + (seat.width - width) / 2;
      const y = seat.top + (seat.height - height) / 2;
      const left = { x: seat.left - GAP - width, y };
      const right = { x: seat.right + GAP, y };
      const nearLeft = seat.left + seat.width / 2 < bounds.left + bounds.width / 2;
      const sides = nearLeft ? [left, right] : [right, left];
      const seats = Array.from(table.querySelectorAll('.game-table-seat [data-player-id]'));
      const tiles = seats.map(tile => tile.getBoundingClientRect());
      const faces = seats.map(tile => (tile.querySelector('.speech-avatar') ?? tile).getBoundingClientRect());

      // Short landscape tables can have several neighbours across the same row.
      const gaps = tiles.flatMap(tile => [tile.left - width - GAP, tile.right + GAP])
        .sort((a, b) => Math.abs(a - x) - Math.abs(b - x));
      const candidates = [
        ...sides, { x, y: seat.top - GAP - height }, { x, y: seat.bottom + GAP },
        ...gaps.map(left => ({ x: left, y })),
      ];
      const [best] = candidates.map(point => {
        const x = Math.max(bounds.left + GAP, Math.min(point.x, bounds.right - width - GAP));
        const y = Math.max(bounds.top + GAP, Math.min(point.y, bounds.bottom - height - GAP));
        const covered = (rects: DOMRect[]) => rects.reduce((area, rect) =>
          area + _overlap(x - GAP, y - GAP, width + 2 * GAP, height + 2 * GAP, rect), 0);
        return { x, y, faces: covered(faces), tiles: covered(tiles) };
      }).sort((a, b) => a.faces - b.faces || a.tiles - b.tiles);

      card.style.left = `${best.x - bounds.left}px`;
      card.style.top = `${best.y - bounds.top}px`;
    };

    position();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    for (const element of [table, cue.seat, card]) observer?.observe(element);
    window.addEventListener('resize', position);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', position);
    };
  }, [cue]);

  return (
    <div ref={cardRef} className="absolute z-[45] w-max pointer-events-none" aria-hidden="true" data-testid="ask-denied-animation">
      <div data-testid="ask-denied-card">
        <PlayingCard cardId={cue.cardId} size="md" />
      </div>
      <span data-testid="ask-denied-x"
        className="absolute -bottom-1 -right-1 grid h-5 w-5 place-items-center rounded-full border border-rose-300 bg-rose-800 text-sm font-bold leading-none text-white">
        ×
      </span>
    </div>
  );
}
