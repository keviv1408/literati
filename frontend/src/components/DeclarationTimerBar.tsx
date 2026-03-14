'use client';

/**
 * DeclarationTimerBar — 60-second countdown specifically for the declaration
 * phase (Step 2 of DeclareModal, card-assignment form).
 *
 * Behaviour:
 *   • Uses requestAnimationFrame for smooth 60fps countdown
 *   • Normal state: emerald progress bar (plenty of time)
 *   • Warning state (≤ WARNING_THRESHOLD_S seconds): amber bar + label pulse
 *   • Danger state  (≤ DANGER_THRESHOLD_S  seconds): red bar + label pulse
 *   • Calls `onExpiry` exactly once when the remaining time reaches 0
 *     (the parent uses this to auto-submit the current declaration assignment)
 *
 * Sub-AC 23a: visible to the declarant; triggers warning state in the final
 * WARNING_THRESHOLD_S seconds; auto-submits via the onExpiry callback on expiry.
 */

import { useState, useEffect, useRef } from 'react';

/** Seconds at which the warning (amber) state is triggered. */
const WARNING_THRESHOLD_S = 10;
/** Seconds at which the danger (red) state is triggered. */
const DANGER_THRESHOLD_S  = 5;

export interface DeclarationTimerBarProps {
  /**
   * Server epoch timestamp (ms) when the declaration phase timer fires.
   * Supplied by the `declaration_timer` WebSocket event.
   */
  expiresAt: number;
  /**
   * Total duration of the declaration phase timer in ms (normally 60 000).
   * Used to compute fill percentage for the progress bar.
   */
  durationMs: number;
  /**
   * Called once when the remaining time reaches zero.
   * The parent DeclareModal should call `handleConfirm()` here to
   * auto-submit the current (potentially partial) card assignment.
   */
  onExpiry?: () => void;
  /** Optional extra Tailwind classes applied to the outer wrapper element. */
  className?: string;
}

export default function DeclarationTimerBar({
  expiresAt,
  durationMs,
  onExpiry,
  className = '',
}: DeclarationTimerBarProps) {
  const [remaining, setRemaining] = useState<number>(() =>
    Math.max(0, expiresAt - Date.now()),
  );

  // Ref so we only fire onExpiry once even if the effect re-runs.
  const onExpiryFiredRef = useRef(false);
  // Keep latest onExpiry in a ref so it's accessible from the RAF closure
  // without recreating the effect.
  const onExpiryRef = useRef(onExpiry);
  useEffect(() => { onExpiryRef.current = onExpiry; }, [onExpiry]);

  // RAF-based smooth countdown; re-runs when expiresAt changes (new timer).
  useEffect(() => {
    onExpiryFiredRef.current = false;

    const tick = () => {
      const r = Math.max(0, expiresAt - Date.now());
      setRemaining(r);
      if (r > 0) {
        rafId = requestAnimationFrame(tick);
      } else if (!onExpiryFiredRef.current) {
        // Time is up — fire auto-submit exactly once.
        onExpiryFiredRef.current = true;
        onExpiryRef.current?.();
      }
    };

    let rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [expiresAt]);

  const secs      = Math.ceil(remaining / 1000);
  const pct       = durationMs > 0 ? Math.min(100, (remaining / durationMs) * 100) : 0;
  // Warning (red) state activates at ≤ WARNING_THRESHOLD_S (10 s) — aligns with
  // CountdownTimer's WARNING_THRESHOLD_S so all timer components are consistent.
  const isWarning = secs <= WARNING_THRESHOLD_S;
  // DANGER_THRESHOLD_S (5 s) drives a more prominent pulse on the seconds label.
  const isDanger  = secs <= DANGER_THRESHOLD_S;

  // ── Colour tokens ──────────────────────────────────────────────────────────
  // Both warning (≤10 s) and danger (≤5 s) use red — danger just adds an extra
  // pulse on the seconds label for additional urgency.
  const fillColour = isWarning ? 'bg-red-500' : 'bg-emerald-400';

  const labelColour = isWarning ? 'text-red-400' : 'text-emerald-300';

  // Seconds label pulses in danger state (≤5s) for additional urgency.
  const secondsColour = isDanger
    ? 'text-red-400 animate-pulse'
    : isWarning
    ? 'text-red-400'
    : 'text-slate-300';

  return (
    <div
      className={`flex flex-col gap-1 ${className}`}
      data-testid="declaration-timer-bar"
    >
      {/* Label row */}
      <div className="flex items-center justify-between text-xs">
        <span
          className={[
            'font-semibold tracking-wide',
            labelColour,
            isWarning ? 'animate-pulse' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          data-testid="declaration-timer-label"
        >
          {isWarning ? '⚠ Declare now!' : 'Declaration timer'}
        </span>

        <span
          className={['font-mono font-bold tabular-nums', secondsColour].join(' ')}
          aria-label={`${secs} seconds remaining to complete declaration`}
          data-testid="declaration-timer-seconds"
        >
          {secs}s
        </span>
      </div>

      {/* Progress bar */}
      <div
        className="w-full h-2 bg-slate-700/50 rounded-full overflow-hidden"
        role="progressbar"
        aria-valuenow={secs}
        aria-valuemin={0}
        aria-valuemax={Math.ceil(durationMs / 1000)}
        aria-label={`Declaration timer: ${secs} seconds remaining`}
        data-testid="declaration-timer-progress"
      >
        <div
          className={['h-full rounded-full transition-none', fillColour].join(' ')}
          style={{ width: `${pct}%` }}
          data-testid="declaration-timer-fill"
        />
      </div>
    </div>
  );
}
