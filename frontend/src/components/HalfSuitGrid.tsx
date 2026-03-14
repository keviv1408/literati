/**
 * HalfSuitGrid — 8-slot scoreboard panel showing all half-suit declarations.
 *
 * Layout: 4 suit columns × 2 tier rows (high on top, low on bottom).
 *
 * Each slot is:
 *   - **Neutral/empty** (slate border, muted text) when unclaimed.
 *   - **Team 1 (emerald)** when Team 1 declared it.
 *   - **Team 2 (violet)** when Team 2 declared it.
 *
 * The high-diamonds slot carries an extra ★ tiebreaker indicator.
 */

import React from 'react';
import { DeclaredSuit, HalfSuitId } from '@/types/game';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUITS_ORDER = ['s', 'h', 'd', 'c'] as const;
type SuitKey = (typeof SUITS_ORDER)[number];

const SUIT_SYMBOLS: Record<SuitKey, string> = {
  s: '♠',
  h: '♥',
  d: '♦',
  c: '♣',
};

/** Suits displayed in red on a real card deck */
const RED_SUITS = new Set<SuitKey>(['h', 'd']);

/** The tiebreaker half-suit — carries a ★ indicator */
const TIEBREAKER_ID = 'high_d';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function suitSymbolClass(suit: SuitKey): string {
  return RED_SUITS.has(suit) ? 'text-red-400' : 'text-slate-300';
}

function tierLabel(tier: 'high' | 'low'): string {
  return tier === 'high' ? '▲' : '▽';
}

// ---------------------------------------------------------------------------
// Sub-component: individual slot
// ---------------------------------------------------------------------------

interface SlotProps {
  halfSuitId: HalfSuitId;
  teamId: 1 | 2 | undefined;
  suit: SuitKey;
  tier: 'high' | 'low';
}

function HalfSuitSlot({ halfSuitId, teamId, suit, tier }: SlotProps) {
  const isTiebreaker = halfSuitId === TIEBREAKER_ID;

  // Visual state classes
  let bgClass: string;
  let borderClass: string;
  let textClass: string;

  if (teamId === 1) {
    bgClass = 'bg-emerald-900/50';
    borderClass = 'border-emerald-600/60';
    textClass = 'text-emerald-300';
  } else if (teamId === 2) {
    bgClass = 'bg-violet-900/50';
    borderClass = 'border-violet-600/60';
    textClass = 'text-violet-300';
  } else {
    bgClass = 'bg-slate-800/40';
    borderClass = 'border-slate-700/40';
    textClass = 'text-slate-500';
  }

  const teamLabel = teamId === 1 ? 'Team 1' : teamId === 2 ? 'Team 2' : 'Unclaimed';
  const tierStr = tier === 'high' ? 'High' : 'Low';
  const suitNames: Record<SuitKey, string> = { s: 'Spades', h: 'Hearts', d: 'Diamonds', c: 'Clubs' };
  const ariaLabel = `${tierStr} ${suitNames[suit]}: ${teamLabel}${isTiebreaker ? ' (tiebreaker)' : ''}`;

  return (
    <div
      role="gridcell"
      aria-label={ariaLabel}
      data-testid={`half-suit-slot-${halfSuitId}`}
      data-team={teamId ?? 'none'}
      className={[
        'relative flex flex-col items-center justify-center',
        'rounded border px-1.5 py-1 min-w-[2.5rem]',
        'transition-colors duration-300',
        bgClass,
        borderClass,
        textClass,
      ].join(' ')}
    >
      {/* Tier indicator (▲/▽) */}
      <span className="text-[9px] leading-none opacity-70" aria-hidden="true">
        {tierLabel(tier)}
      </span>

      {/* Suit symbol */}
      <span
        className={['text-sm font-bold leading-none', suitSymbolClass(suit)].join(' ')}
        aria-hidden="true"
      >
        {SUIT_SYMBOLS[suit]}
      </span>

      {/* Tiebreaker star */}
      {isTiebreaker && (
        <span
          className="absolute -top-1.5 -right-1.5 text-[8px] leading-none text-yellow-400"
          aria-hidden="true"
          title="Tiebreaker half-suit"
        >
          ★
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface HalfSuitGridProps {
  /** Array of declared suits from PublicGameState.declaredSuits */
  declaredSuits: DeclaredSuit[];
  /** Optional extra className for the wrapper */
  className?: string;
}

/**
 * Renders an 8-slot grid showing all half-suit declarations.
 *
 * Layout: 4 columns (Spades, Hearts, Diamonds, Clubs) × 2 rows (High, Low).
 * High row is on top, low row is on the bottom — matching the suit hierarchy.
 *
 * @example
 * <HalfSuitGrid declaredSuits={gameState.declaredSuits} />
 */
export function HalfSuitGrid({ declaredSuits, className }: HalfSuitGridProps) {
  // Build a fast lookup: halfSuitId → teamId
  const declaredMap = React.useMemo(() => {
    const map = new Map<HalfSuitId, 1 | 2>();
    for (const ds of declaredSuits) {
      map.set(ds.halfSuitId, ds.teamId);
    }
    return map;
  }, [declaredSuits]);

  return (
    <div
      role="grid"
      aria-label="Half-suit scoreboard"
      data-testid="half-suit-grid"
      className={['grid grid-cols-4 gap-1', className].filter(Boolean).join(' ')}
    >
      {/* Row labels (aria) provided by each slot's aria-label */}

      {/* High row */}
      {SUITS_ORDER.map((suit) => {
        const id = `high_${suit}` as HalfSuitId;
        return (
          <HalfSuitSlot
            key={id}
            halfSuitId={id}
            teamId={declaredMap.get(id)}
            suit={suit}
            tier="high"
          />
        );
      })}

      {/* Low row */}
      {SUITS_ORDER.map((suit) => {
        const id = `low_${suit}` as HalfSuitId;
        return (
          <HalfSuitSlot
            key={id}
            halfSuitId={id}
            teamId={declaredMap.get(id)}
            suit={suit}
            tier="low"
          />
        );
      })}
    </div>
  );
}

export default HalfSuitGrid;
