'use client';

import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cardLabel, parseCard, SUIT_COLORS, type CardId } from '@/types/game';

export type AskSpeechBubbleState = { seat: HTMLElement; text: string } & (
  | { variant: 'ask'; cards: CardId[] }
  | { variant: 'given' | 'denied' | 'declared' }
);

const CARD_LIST = new Intl.ListFormat('en-US', { type: 'conjunction' });

function _renderCards(cards: CardId[]) {
  return CARD_LIST.formatToParts(cards).map(({ type, value }) => {
    if (type === 'literal') return value;
    const { suit } = parseCard(value);
    return (
      <span key={value} className={`whitespace-nowrap rounded-sm bg-amber-50 px-0.5 font-semibold ${SUIT_COLORS[suit]}`}>
        {cardLabel(value)}
      </span>
    );
  });
}

const VARIANT_CLASSES: Record<AskSpeechBubbleState['variant'], string> = {
  ask: 'border-amber-300/70 text-amber-50',
  given: 'border-emerald-400/70 text-emerald-50',
  denied: 'border-rose-400/70 text-rose-50',
  declared: 'border-emerald-400/70 text-emerald-50',
};

export default function AskSpeechBubbleOverlay({ bubble }: { bubble: AskSpeechBubbleState }) {
  const { seat, text, variant } = bubble;
  const space = seat.closest<HTMLElement>('.game-table-space');
  const bodyRef = useRef<HTMLDivElement>(null);
  const tailRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const tail = tailRef.current;
    if (!space || !body || !tail) return;
    const avatar = seat.querySelector('.speech-avatar') ?? seat;
    const position = () => {
      const bounds = space.getBoundingClientRect();
      const face = avatar.getBoundingClientRect();
      const box = body.getBoundingClientRect();
      const center = face.left + face.width / 2 - bounds.left;
      const left = Math.max(0, Math.min(center - box.width / 2, bounds.width - box.width));
      // The rotated 12px tail reaches 8px beyond the body to touch the avatar.
      const above = face.top - bounds.top - box.height >= 8 && !seat.closest('[data-upper-seat]');
      body.style.left = `${left}px`;
      body.style.top = `${above ? face.top - bounds.top - box.height - 8 : face.bottom - bounds.top + 8}px`;
      body.dataset.placement = above ? 'above' : 'below';
      tail.style.left = `${Math.max(12, Math.min(center - left, box.width - 12))}px`;
    };

    position();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    for (const element of [space, avatar, seat, body]) observer?.observe(element);
    window.addEventListener('resize', position);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', position);
    };
  }, [space, seat, bubble]);

  if (!space) return null;
  return createPortal(
    <div className="pointer-events-none absolute inset-0 z-50 overflow-hidden" aria-hidden="true" data-testid={`${variant}-speech-bubble-overlay`}>
      <div
        ref={bodyRef}
        className={`group absolute w-max max-w-[min(18rem,100%)] rounded-2xl border bg-slate-950 px-3 py-1.5 text-center text-sm leading-tight font-medium wrap-anywhere shadow-lg sm:max-w-[min(22rem,100%)] ${VARIANT_CLASSES[variant]}`}
        data-testid={`${variant}-speech-bubble`}
      >
        <span data-testid={`${variant}-speech-bubble-text`}>
          {text}{bubble.variant === 'ask' && <> {_renderCards(bubble.cards)}?</>}
        </span>
        <span
          ref={tailRef}
          className="absolute -top-1.5 h-3 w-3 -translate-x-1/2 rotate-45 border border-inherit border-r-0 border-b-0 bg-slate-950 group-data-[placement=above]:top-auto group-data-[placement=above]:-bottom-1.5 group-data-[placement=above]:rotate-[225deg]"
        />
      </div>
    </div>,
    space,
  );
}
