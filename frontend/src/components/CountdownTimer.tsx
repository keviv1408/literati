'use client';

/**
 * CountdownTimer — generic server-clock countdown with a red warning state.
 *
 * This is the canonical countdown primitive shared across all timer contexts
 * (turn timer, declaration timer, spectator view).
 *
 * ### Visual states
 * | Remaining time | Bar colour           | Label colour  | Pulse |
 * |----------------|----------------------|---------------|-------|
 * | > 10 s         | emerald (my timer)   | emerald       | no    |
 * |                | slate   (other)      | slate         | no    |
 * | ≤ 10 s         | red-500              | red-400       | yes   |
 * | 0 s            | none (width: 0%)     | red-400       | yes   |
 *
 * ### Behaviour
 * - Uses `requestAnimationFrame` for smooth 60 fps progress.
 * - The RAF loop stops automatically once `remaining` reaches 0.
 * - `onExpiry` fires **exactly once** when the remaining time first hits 0.
 *   Passing a new `expiresAt` resets the fired-flag so the callback can fire
 *   again for the next timer instance.
 * - `isMyTimer` drives the "normal" colour scheme (emerald vs slate) but has
 *   no effect once the warning threshold (≤ 10 s) is reached — both cases go
 *   red.
 *
 * @param expiresAt  Server epoch ms when the timer fires.
 * @param durationMs Total duration in ms (used to compute the fill percentage).
 * @param label      Text shown on the left side of the label row.
 * @param isMyTimer  Whether the timer belongs to the local player.
 * @param onExpiry   Called once when remaining time reaches 0.
 * @param className  Extra Tailwind classes applied to the outer wrapper.
 */

import { useState, useEffect, useRef } from 'react';

/** Seconds at which the warning (red) state is triggered. */
export const WARNING_THRESHOLD_S = 10;

export interface CountdownTimerProps {
  /** Server epoch timestamp (ms) when the timer fires. */
  expiresAt: number;
  /** Total duration of the timer in ms — used to compute fill percentage. */
  durationMs: number;
  /** Label text rendered on the left side of the label row. */
  label?: string;
  /**
   * Whether the timer belongs to the local player.
   * Drives the emerald (my timer) vs slate (other) colour when time > 10 s.
   * Default: false.
   */
  isMyTimer?: boolean;
  /**
   * Called once when the remaining time first reaches 0.
   * Typically used to auto-submit a declaration or trigger a bot move.
   */
  onExpiry?: () => void;
  /** Optional extra Tailwind classes applied to the outer wrapper element. */
  className?: string;
}

export default function CountdownTimer({
  expiresAt,
  durationMs,
  label = 'Timer',
  isMyTimer = false,
  onExpiry,
  className = '',
}: CountdownTimerProps) {
  const [remaining, setRemaining] = useState<number>(() =>
    Math.max(0, expiresAt - Date.now()),
  );

  // Ref so we only fire onExpiry once even if the effect re-runs.
  const onExpiryFiredRef = useRef(false);
  // Keep latest onExpiry in a ref so the RAF closure can call it without
  // being re-created every render.
  const onExpiryRef = useRef(onExpiry);
  useEffect(() => { onExpiryRef.current = onExpiry; }, [onExpiry]);

  // RAF-based smooth countdown; re-runs only when expiresAt changes (new timer).
  useEffect(() => {
    // Reset the fired flag for the new timer instance.
    onExpiryFiredRef.current = false;

    const tick = () => {
      const r = Math.max(0, expiresAt - Date.now());
      setRemaining(r);
      if (r > 0) {
        rafId = requestAnimationFrame(tick);
      } else if (!onExpiryFiredRef.current) {
        onExpiryFiredRef.current = true;
        onExpiryRef.current?.();
      }
    };

    let rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [expiresAt]);

  const secs      = Math.ceil(remaining / 1000);
  const pct       = durationMs > 0 ? Math.min(100, (remaining / durationMs) * 100) : 0;
  const isWarning = secs <= WARNING_THRESHOLD_S;

  // ── Colour tokens ────────────────────────────────────────────────────────
  const fillColour = isWarning
    ? 'bg-red-500'
    : isMyTimer
    ? 'bg-emerald-400'
    : 'bg-slate-500';

  const labelColour = isWarning ? 'text-red-400' : isMyTimer ? 'text-emerald-300' : 'text-slate-400';
  const secsColour  = isWarning ? 'text-red-400' : 'text-slate-300';

  return (
    <div
      className={`flex flex-col gap-1 ${className}`}
      data-testid="countdown-timer"
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
          data-testid="countdown-timer-label"
        >
          {label}
        </span>
        <span
          className={[
            'font-mono font-bold tabular-nums',
            secsColour,
            isWarning ? 'animate-pulse' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-label={`${secs} seconds remaining`}
          data-testid="countdown-timer-seconds"
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
        aria-valuemax={Math.ceil(durationMs / 1000)}
        aria-label={`${secs} seconds remaining`}
        data-testid="countdown-timer-bar"
      >
        <div
          className={['h-full rounded-full transition-none', fillColour].join(' ')}
          style={{ width: `${pct}%` }}
          data-testid="countdown-timer-fill"
        />
      </div>
    </div>
  );
}
