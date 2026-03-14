'use client';

/**
 * DealAnimation — overlays a brief card shuffle + deal animation (~1.4 s).
 *
 * Triggered once when `game_init` is first received (fresh deal).
 * Does NOT fire on reconnect / page-refresh (the parent uses a ref-guard).
 *
 * Visual sequence
 * ───────────────
 *   0 – 400 ms  : deck shuffle  (the stacked face-down cards wobble)
 *   400 – 1400 ms: deal phase   (face-down cards fly outward, one per player)
 *   1400 ms     : onComplete() fires and the component unmounts
 *
 * The overlay is `aria-hidden` and `pointer-events-none` so it never blocks
 * game controls or the accessibility tree while it plays.
 */

import { useEffect, useRef, useState } from 'react';

// ── Timing constants ──────────────────────────────────────────────────────────
const SHUFFLE_MS      = 400;
const DEAL_CARD_MS    = 600;   // duration of each flying-card animation
const DEAL_STAGGER_MS = 70;    // delay between consecutive flying cards
const TOTAL_DEAL_MS   = 1000;  // total length of deal phase

/** Pixels each flying card travels from center */
const DEAL_DISTANCE = 140;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DealAnimationProps {
  /**
   * Total number of players (6 or 8).
   * Controls the number of flying cards — one per player, spread evenly.
   */
  playerCount: 6 | 8;
  /** Called once the full animation has finished. */
  onComplete: () => void;
}

type Phase = 'shuffling' | 'dealing' | 'done';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute angle offsets (degrees, clockwise from 12 o'clock) for `count`
 * evenly-distributed flying cards.
 */
function getDealAngles(count: number): number[] {
  return Array.from({ length: count }, (_, i) => (i / count) * 360);
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function DealAnimation({ playerCount, onComplete }: DealAnimationProps) {
  const [phase, setPhase] = useState<Phase>('shuffling');
  // Keep a stable ref to onComplete so the effect closure never goes stale
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const t1 = setTimeout(() => setPhase('dealing'), SHUFFLE_MS);
    const t2 = setTimeout(() => {
      setPhase('done');
      onCompleteRef.current();
    }, SHUFFLE_MS + TOTAL_DEAL_MS);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  // Once the phase is 'done' the component renders nothing — it unmounts.
  if (phase === 'done') return null;

  const angles = getDealAngles(playerCount);

  return (
    <div
      className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center"
      aria-hidden="true"
      data-testid="deal-animation"
    >
      {/* ── Deck of stacked face-down cards in the centre ── */}
      <div
        className={phase === 'shuffling' ? 'animate-deck-shuffle' : ''}
        style={{ position: 'relative', width: '2.5rem', height: '4rem' }}
      >
        {/* Bottom cards in the stack */}
        {[4, 3, 2, 1, 0].map((stackIdx) => (
          <div
            key={stackIdx}
            className="absolute w-10 h-16 rounded-lg border-2 border-blue-700 bg-blue-900 shadow-md"
            style={{
              top:       -stackIdx * 1.5,
              left:       stackIdx * 0.8,
              transform: `rotate(${(stackIdx - 2) * 0.8}deg)`,
            }}
          >
            <div className="absolute inset-1 rounded border border-blue-600/50 bg-blue-800/50" />
            <div className="absolute inset-2 rounded border border-blue-500/30" />
          </div>
        ))}

        {/* Top card (highest z-index) */}
        <div
          className="absolute w-10 h-16 rounded-lg border-2 border-blue-700 bg-blue-900 shadow-lg"
          style={{ zIndex: 10 }}
        >
          <div className="absolute inset-1 rounded border border-blue-600/50 bg-blue-800/50" />
          <div className="absolute inset-2 rounded border border-blue-500/30" />
        </div>
      </div>

      {/* ── Flying cards — only visible during deal phase ── */}
      {phase === 'dealing' &&
        angles.map((angleDeg, i) => {
          const rad = (angleDeg * Math.PI) / 180;
          const dx = Math.sin(rad) * DEAL_DISTANCE;
          const dy = -Math.cos(rad) * DEAL_DISTANCE;

          return (
            <div
              key={i}
              data-testid="deal-animation-card"
              className="absolute w-10 h-16 rounded-lg border-2 border-blue-700 bg-blue-900 shadow-lg animate-card-deal"
              style={
                {
                  '--deal-dx':         `${dx}px`,
                  '--deal-dy':         `${dy}px`,
                  animationDelay:    `${i * DEAL_STAGGER_MS}ms`,
                  animationDuration: `${DEAL_CARD_MS}ms`,
                } as React.CSSProperties
              }
            >
              <div className="absolute inset-1 rounded border border-blue-600/50 bg-blue-800/50" />
              <div className="absolute inset-2 rounded border border-blue-500/30" />
            </div>
          );
        })}
    </div>
  );
}
