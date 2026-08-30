'use client';

import { useLayoutEffect, useRef } from 'react';

export type SpeechBubbleVariant = 'ask' | 'denied' | 'declared';

export interface AskSpeechBubbleState {
  text: string;
  anchorX: number;
  anchorY: number;
  placement: 'above' | 'below';
  variant?: SpeechBubbleVariant;
}

const VARIANT_CLASSES: Record<SpeechBubbleVariant, string> = {
  ask: 'border-amber-300/70 text-amber-50',
  denied: 'border-rose-400/70 text-rose-50',
  declared: 'border-emerald-400/70 text-emerald-50',
};

interface AskSpeechBubbleOverlayProps {
  bubble: AskSpeechBubbleState;
}

const EDGE_PAD = 12;

export default function AskSpeechBubbleOverlay({
  bubble,
}: AskSpeechBubbleOverlayProps) {
  const isAbove = bubble.placement === 'above';
  const variant = bubble.variant ?? 'ask';
  const variantClasses = VARIANT_CLASSES[variant];
  const bubbleRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);

  // Apply horizontal nudge synchronously before paint to avoid a visible flash.
  // Also update the caret position so it always points at the player's seat.
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el) return;

    // Reset any previous nudge so getBoundingClientRect reflects the natural position.
    el.style.transform = '';

    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;

    let shift = 0;
    if (rect.left < EDGE_PAD) {
      shift = EDGE_PAD - rect.left;
    } else if (rect.right > vw - EDGE_PAD) {
      shift = vw - EDGE_PAD - rect.right;
    }

    if (shift !== 0) {
      el.style.transform = `translateX(${shift}px)`;
    }

    // Keep the caret pointing at the original anchorX regardless of nudge.
    const caret = caretRef.current;
    if (caret && rect.width > 0) {
      const bubbleLeft = rect.left + shift;
      const caretPct = ((bubble.anchorX - bubbleLeft) / rect.width) * 100;
      caret.style.left = `${Math.min(Math.max(caretPct, 8), 92)}%`;
    }
  });

  return (
    <div
      className="fixed inset-0 z-50 pointer-events-none"
      aria-hidden="true"
      data-testid={`${variant}-speech-bubble-overlay`}
    >
      <div
        className="absolute"
        style={{
          left: bubble.anchorX,
          top: bubble.anchorY,
          transform: isAbove ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
        }}
      >
        <div
          ref={bubbleRef}
          className={`relative max-w-[18rem] rounded-2xl border bg-slate-950/95 px-3 py-2 text-center text-sm leading-snug font-medium shadow-[0_10px_30px_rgba(15,23,42,0.45)] sm:max-w-[22rem] ${variantClasses}`}
          data-testid={`${variant}-speech-bubble`}
        >
          <span data-testid={`${variant}-speech-bubble-text`}>{bubble.text}</span>
          <span
            ref={caretRef}
            className={[
              'absolute h-3 w-3 -translate-x-1/2 rotate-45 border bg-slate-950/95',
              variantClasses,
              isAbove ? '-bottom-1.5 border-l-0 border-t-0' : '-top-1.5 border-b-0 border-r-0',
            ].join(' ')}
            style={{ left: '50%' }}
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
}
