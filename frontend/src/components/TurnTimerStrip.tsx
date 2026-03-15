'use client';

/**
 * TurnTimerStrip — compact inline timer for use inside modals.
 *
 * Shows a progress bar + countdown text so the 30-second turn timer remains
 * visible even when the AskCardModal or DeclareModal overlay covers the
 * main `TurnTimerBar` that lives in the game page layout.
 *
 * Props:
 *   expiresAt  — server epoch ms when the timer fires (from `turn_timer` WS event)
 *   durationMs — total duration of this timer in ms (usually 30_000)
 *   isMyTimer  — true when it's the local player's turn (drives green vs grey bar)
 *   className  — optional extra Tailwind classes on the wrapper
 *
 * Behaviour:
 *   • Uses requestAnimationFrame for smooth 60fps progress animation
 *   • Bar turns red (warning state) when ≤ 10 s remain (WARNING_THRESHOLD_S)
 *   • Countdown label pulses when in the warning zone (≤ 10 s)
 *   • Automatically stops the RAF loop once remaining reaches 0
 */

import { useState, useEffect } from 'react';
import type { TurnTimerPayload } from '@/hooks/useGameSocket';
import { WARNING_THRESHOLD_S } from './CountdownTimer';

export interface TurnTimerStripProps {
  /** Full `turn_timer` payload from the server. */
  turnTimer: TurnTimerPayload;
  /** Whether the timer belongs to the local player. */
  isMyTimer: boolean;
  /** Optional extra class names for the wrapper element. */
  className?: string;
}

export default function TurnTimerStrip({
  turnTimer,
  isMyTimer,
  className = '',
}: TurnTimerStripProps) {
  const [remaining, setRemaining] = useState<number>(() =>
    Math.max(0, turnTimer.expiresAt - Date.now()),
  );

  // Smooth countdown via requestAnimationFrame.
  // Re-runs only when expiresAt changes (i.e. a new timer arrives).
  useEffect(() => {
    const tick = () => {
      const r = Math.max(0, turnTimer.expiresAt - Date.now());
      setRemaining(r);
      if (r > 0) {
        rafId = requestAnimationFrame(tick);
      }
    };
    let rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [turnTimer.expiresAt]);

  const pct      = Math.min(100, (remaining / turnTimer.durationMs) * 100);
  const secs     = Math.ceil(remaining / 1000);
  // Warning (red) state activates at ≤ WARNING_THRESHOLD_S seconds (10 s).
  const isWarning = secs <= WARNING_THRESHOLD_S;

  // Colour scheme: red during warning zone, otherwise emerald (my timer) or slate.
  const fillColour = isWarning
    ? 'bg-red-500'
    : isMyTimer
    ? 'bg-emerald-400'
    : 'bg-slate-500';

  const labelColour = isWarning
    ? 'text-red-400'
    : isMyTimer
    ? 'text-emerald-300'
    : 'text-slate-400';

  return (
    <div
      className={`flex flex-col gap-1 ${className}`}
      data-testid="turn-timer-strip"
    >
      {/* Label row */}
      <div className="flex items-center justify-between text-xs">
        <span
          className={[
            'font-medium',
            labelColour,
            isWarning ? 'animate-pulse' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {isMyTimer ? 'Your turn' : 'Turn timer'}
        </span>
        <span
          className={[
            'font-mono font-bold tabular-nums',
            isWarning ? 'text-red-400 animate-pulse' : 'text-slate-300',
          ].join(' ')}
          aria-label={`${secs} seconds remaining`}
          data-testid="turn-timer-seconds"
        >
          {secs}s
        </span>
      </div>

      {/* Progress bar */}
      <div
        className="w-full h-1.5 bg-slate-700/50 rounded-full overflow-hidden"
        role="progressbar"
        aria-valuenow={secs}
        aria-valuemin={0}
        aria-valuemax={Math.ceil(turnTimer.durationMs / 1000)}
        aria-label={`${secs} seconds remaining`}
        data-testid="turn-timer-strip-bar"
      >
        <div
          className={['h-full rounded-full transition-none', fillColour].join(' ')}
          style={{ width: `${pct}%` }}
          data-testid="turn-timer-strip-fill"
        />
      </div>
    </div>
  );
}
