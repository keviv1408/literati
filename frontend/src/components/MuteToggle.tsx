'use client';

/**
 * MuteToggle — per-player mute/unmute button for game audio.
 *
 * Wraps the `useAudio` hook to expose a single, self-contained toggle button
 * that:
 *  - Reads the initial mute state from `localStorage` on mount (via the hook)
 *  - Renders 🔇 (muted) or 🔔 (unmuted) with appropriate aria attributes
 *  - Persists the toggled preference to `localStorage` so it survives page
 *    refreshes, back-navigation, and WebSocket reconnects
 *  - Suppresses all game sounds (turn chimes etc.) when in the muted state by
 *    delegating to `isMuted()` inside `playTurnChime()` in `@/lib/audio`
 *
 * The component is intentionally presentational: all state lives in
 * `useAudio`, which stores the preference under `'literati:muted'` in
 * `localStorage`.
 *
 * ### Accessibility
 * - `aria-pressed` reflects the current mute state (true = sounds off).
 * - `aria-label` changes dynamically so screen-reader users know what will
 *   happen on the *next* click (same pattern as a standard mute button).
 * - Visible emoji icon is `aria-hidden` to avoid double-announcing.
 * - Focus ring is always visible (not hidden behind `focus-visible` only) for
 *   keyboard-only players.
 *
 * @example
 * // Drop it anywhere in the game UI — no props required
 * import MuteToggle from '@/components/MuteToggle';
 * <MuteToggle />
 *
 * @example
 * // Override the base styling while keeping behavior
 * <MuteToggle className="p-2 text-lg" />
 */

import React from 'react';
import { useAudio } from '@/hooks/useAudio';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface MuteToggleProps {
  /**
   * Additional Tailwind utility classes merged onto the button element.
   * Use this to adjust padding, font-size, or colours at the call-site
   * without forking the component.
   *
   * @default ''
   */
  className?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Self-contained mute/unmute toggle button.
 * Reads and persists preference via `localStorage` through `useAudio`.
 */
const MuteToggle: React.FC<MuteToggleProps> = ({ className = '' }) => {
  const { muted, toggleMute } = useAudio();

  return (
    <button
      type="button"
      onClick={toggleMute}
      aria-label={muted ? 'Unmute game sounds' : 'Mute game sounds'}
      aria-pressed={muted}
      title={muted ? 'Unmute sounds' : 'Mute sounds'}
      className={[
        // Base: subtle slate → white on hover; always-visible focus ring
        'text-slate-400 hover:text-white transition-colors',
        'p-1 rounded-lg',
        'focus:outline-none focus:ring-2 focus:ring-emerald-400',
        'text-base leading-none',
        // Active (muted) state gets a mild red tint so it's visually distinct
        muted ? 'text-rose-400 hover:text-rose-300' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="mute-toggle"
    >
      {/* Visible icon: aria-hidden so screen-reader uses the aria-label */}
      <span aria-hidden="true">{muted ? '🔇' : '🔔'}</span>
    </button>
  );
};

export default MuteToggle;
