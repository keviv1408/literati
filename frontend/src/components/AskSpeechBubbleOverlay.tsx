'use client';

import { useEffect, useRef, useState } from 'react';

export interface AskSpeechBubbleState {
  text: string;
  anchorX: number;
  anchorY: number;
  placement: 'above' | 'below';
}

interface AskSpeechBubbleOverlayProps {
  bubble: AskSpeechBubbleState;
}

const EDGE_PAD = 12;

export default function AskSpeechBubbleOverlay({
  bubble,
}: AskSpeechBubbleOverlayProps) {
  const isAbove = bubble.placement === 'above';
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [nudge, setNudge] = useState(0);

  useEffect(() => {
    const el = bubbleRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;

    let shift = 0;
    if (rect.left < EDGE_PAD) {
      shift = EDGE_PAD - rect.left;
    } else if (rect.right > vw - EDGE_PAD) {
      shift = vw - EDGE_PAD - rect.right;
    }
    setNudge(shift);
  }, [bubble.anchorX, bubble.text]);

  return (
    <div
      className="fixed inset-0 z-50 pointer-events-none"
      aria-hidden="true"
      data-testid="ask-speech-bubble-overlay"
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
          className="relative max-w-[18rem] rounded-2xl border border-amber-300/70 bg-slate-950/95 px-3 py-2 text-center text-sm leading-snug font-medium text-amber-50 shadow-[0_10px_30px_rgba(15,23,42,0.45)] sm:max-w-[22rem]"
          style={nudge !== 0 ? { transform: `translateX(${nudge}px)` } : undefined}
          data-testid="ask-speech-bubble"
        >
          <span data-testid="ask-speech-bubble-text">{bubble.text}</span>
          <span
            className={[
              'absolute left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 border border-amber-300/70 bg-slate-950/95',
              isAbove ? '-bottom-1.5 border-l-0 border-t-0' : '-top-1.5 border-b-0 border-r-0',
            ].join(' ')}
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
  );
}
