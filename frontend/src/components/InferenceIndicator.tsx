'use client';

/**
 * InferenceIndicator — compact overlay shown on a player seat when inference
 * mode is active, summarising how many of that player's cards are inferred.
 *
 * ### What it shows
 * | Badge          | When rendered                                          |
 * |----------------|--------------------------------------------------------|
 * | "🔍 N"         | N > 0 cards are confirmed to be with this player       |
 * | "✕N" (muted)   | N > 0 cards are confirmed NOT to be with this player   |
 *
 * The indicator is intentionally minimal so it fits inside the compact
 * `GamePlayerSeat` chip without cluttering the layout.
 *
 * ### Accessibility
 * - A hidden `<span>` provides a screen-reader accessible label.
 * - The visual badges are `aria-hidden` to avoid duplicate text.
 *
 * @example
 * <InferenceIndicator
 *   playerId="player-abc"
 *   inference={{ '5_h': 'confirmed', '3_h': 'excluded' }}
 * />
 * // → renders "🔍 1" green badge + "✕1" muted badge
 */

import React from 'react';
import type { PlayerInference } from '@/hooks/useCardInference';

// ── Props ─────────────────────────────────────────────────────────────────────

export interface InferenceIndicatorProps {
  /** The player whose inference data is being displayed. Used for aria-label only. */
  playerId: string;

  /**
   * Inference data for this player.
   * `{ [cardId]: 'confirmed' | 'excluded' }`
   *
   * Absence of a card key means "unknown" — not rendered.
   * Pass an empty object `{}` if there is no inference data yet; the component
   * returns `null` in that case (unless `sharePercent` is provided).
   */
  inference: PlayerInference;

  /**
   * Uniform-distribution probability percentage (0–100) for this player.
   *
   * When provided and > 0, a cyan `~XX%` badge is rendered showing the
   * player's expected share of unknown cards under the uniform-distribution
   * model: P(player holds unknown card) = player.cardCount / total_unknown_cards.
   *
   * Pass 0 or omit to suppress the badge (e.g. for the local player
   * whose cards are fully known, or when inference mode is inactive).
   */
  sharePercent?: number;

  /** Extra Tailwind classes forwarded to the root wrapper. */
  className?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Shows a concise summary of per-player inference confidence.
 * Returns null if there is no inference data to display.
 */
const InferenceIndicator: React.FC<InferenceIndicatorProps> = ({
  playerId,
  inference,
  sharePercent,
  className = '',
}) => {
  const entries = Object.values(inference);
  const confirmedCount = entries.filter((v) => v === 'confirmed').length;
  const excludedCount  = entries.filter((v) => v === 'excluded').length;
  const showSharePercent = sharePercent !== undefined && sharePercent > 0;

  // Nothing to show — bail early so the seat layout is unaffected
  if (confirmedCount === 0 && excludedCount === 0 && !showSharePercent) return null;

  return (
    <div
      className={['flex items-center gap-0.5 flex-wrap justify-center', className].join(' ')}
      data-testid="inference-indicator"
      data-player-id={playerId}
    >
      {/* Accessible label for screen readers */}
      <span className="sr-only">
        {[
          confirmedCount > 0 && `${confirmedCount} card${confirmedCount !== 1 ? 's' : ''} confirmed`,
          excludedCount > 0  && `${excludedCount} card${excludedCount !== 1 ? 's' : ''} excluded`,
          showSharePercent   && `~${sharePercent}% probability under uniform distribution`,
        ]
          .filter(Boolean)
          .join(', ')}{' '}
        inferred for this player
      </span>

      {/* Confirmed badge — sky blue tint */}
      {confirmedCount > 0 && (
        <span
          className={[
            'inline-flex items-center gap-px',
            'px-1 py-px rounded text-[7px] font-bold leading-none select-none',
            'bg-sky-900/80 text-sky-300 border border-sky-700/50',
          ].join(' ')}
          aria-hidden="true"
          data-testid="inference-confirmed-badge"
          title={`${confirmedCount} confirmed card${confirmedCount !== 1 ? 's' : ''}`}
        >
          🔍{confirmedCount}
        </span>
      )}

      {/* Excluded badge — neutral / muted */}
      {excludedCount > 0 && (
        <span
          className={[
            'inline-flex items-center gap-px',
            'px-1 py-px rounded text-[7px] font-bold leading-none select-none',
            'bg-slate-800/80 text-slate-500 border border-slate-700/50',
          ].join(' ')}
          aria-hidden="true"
          data-testid="inference-excluded-badge"
          title={`${excludedCount} card${excludedCount !== 1 ? 's' : ''} not held`}
        >
          ✕{excludedCount}
        </span>
      )}

      {/* Uniform-distribution probability badge — cyan */}
      {showSharePercent && (
        <span
          className={[
            'inline-flex items-center',
            'px-1 py-px rounded text-[7px] font-bold leading-none select-none',
            'bg-cyan-900/70 text-cyan-300 border border-cyan-700/50',
          ].join(' ')}
          aria-hidden="true"
          data-testid="inference-share-badge"
          title={`~${sharePercent}% of unknown cards (uniform distribution)`}
        >
          ~{sharePercent}%
        </span>
      )}
    </div>
  );
};

export default InferenceIndicator;
