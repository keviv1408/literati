'use client';

/**
 * CardFlightAnimation — overlays a face-up card that flies from one player's
 * seat position to another, simulating the physical card transfer after a
 * successful ask_card result.
 *
 * The component:
 *  • Mounts as a fixed full-viewport overlay (pointer-events-none, aria-hidden)
 *  • Positions the transferred card at the source seat centre (viewport coordinates)
 *  • Applies `animate-card-flight` which translates by (--flight-dx, --flight-dy)
 *    to land on the destination seat centre, with a slight arc lift at mid-flight
 *  • Calls `onComplete` after FLIGHT_DURATION_MS and expects the parent to unmount it
 *
 * The parent (game page) is responsible for:
 *  1. Detecting a successful ask_result event
 *  2. Querying the DOM for both player seats via `[data-player-id]` attributes
 *  3. Computing viewport-coordinate centres from getBoundingClientRect()
 *  4. Mounting this component with the computed from/to coordinates
 *  5. Unmounting on onComplete (by clearing the flight state)
 *
 * Visual style: uses the shared PlayingCard face-up rendering so every player
 * can clearly see which exact card changed hands.
 */

import { useEffect, useRef } from 'react';
import type { CardId } from '@/types/game';
import PlayingCard from './PlayingCard';

// ── Constants ──────────────────────────────────────────────────────────────────

/** Total duration of the card flight animation in milliseconds. */
export const FLIGHT_DURATION_MS = 1500;

/** Width of the flying card element in pixels (matches w-10 = 40px). */
const CARD_W = 40;

/** Height of the flying card element in pixels (matches h-16 = 64px). */
const CARD_H = 64;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CardFlightAnimationProps {
  /** The specific card being transferred. */
  cardId: CardId;

  /**
   * X coordinate (horizontal, in viewport pixels) of the centre of the source
   * seat — i.e. the player who gave up the card.
   */
  fromX: number;

  /**
   * Y coordinate (vertical, in viewport pixels) of the centre of the source
   * seat — i.e. the player who gave up the card.
   */
  fromY: number;

  /**
   * X coordinate (horizontal, in viewport pixels) of the centre of the
   * destination seat — i.e. the player who receives the card.
   */
  toX: number;

  /**
   * Y coordinate (vertical, in viewport pixels) of the centre of the
   * destination seat — i.e. the player who receives the card.
   */
  toY: number;

  /**
   * Called exactly once, after FLIGHT_DURATION_MS, when the animation completes.
   * The parent should unmount this component (or clear the flight state) in
   * response to keep the overlay from persisting.
   */
  onComplete: () => void;
}

// ── Component ──────────────────────────────────────────────────────────────────

/**
 * `CardFlightAnimation` renders a single face-up card that flies from
 * `(fromX, fromY)` to `(toX, toY)` in viewport coordinates.
 */
export default function CardFlightAnimation({
  cardId,
  fromX,
  fromY,
  toX,
  toY,
  onComplete,
}: CardFlightAnimationProps) {
  // Stable ref so the effect closure never captures a stale callback
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const t = setTimeout(() => {
      onCompleteRef.current();
    }, FLIGHT_DURATION_MS);
    return () => clearTimeout(t);
  }, []);

  // Delta from source centre to destination centre
  const dx = toX - fromX;
  const dy = toY - fromY;

  // Position the card element so its centre aligns with the source seat centre
  const left = fromX - CARD_W / 2;
  const top  = fromY - CARD_H / 2;

  return (
    <div
      className="fixed inset-0 z-50 pointer-events-none"
      aria-hidden="true"
      data-testid="card-flight-animation"
    >
      {/* Flying card — rendered face-up so all players can identify it. */}
      <div
        className="absolute animate-card-flight"
        style={
          {
            left,
            top,
            width:  CARD_W,
            height: CARD_H,
            '--flight-dx': `${dx}px`,
            '--flight-dy': `${dy}px`,
            animationDuration: `${FLIGHT_DURATION_MS}ms`,
          } as React.CSSProperties
        }
        data-testid="card-flight-card"
      >
        <PlayingCard
          cardId={cardId}
          size="md"
          className="w-10 h-16 shadow-xl"
        />
      </div>
    </div>
  );
}
