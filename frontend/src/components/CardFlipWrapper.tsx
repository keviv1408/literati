'use client';

/**
 * CardFlipWrapper — renders a playing card with a 3-D flip animation
 * that transitions from the card-back to the card-face when first mounted.
 *
 * Used when a card arrives in the recipient's hand after a successful ask.
 * The 550 ms animation plays once then settles to the normal face-up view.
 *
 * Implementation
 * ──────────────
 * The component renders a perspective-container div with two child faces:
 *
 *   • Front face (face-up card): no additional rotation, visible at the END
 *     of the animation (when the inner div is at rotateY(0°)).
 *
 *   • Back face  (face-down card): rotated 180 ° relative to the inner div,
 *     visible at the START of the animation (when the inner div is at
 *     rotateY(180°) the net rotation seen by the viewer is 0°).
 *
 * Both faces carry `backface-visibility: hidden` so only the correct face
 * is ever visible.  The `.animate-card-flip-reveal` CSS class (defined in
 * globals.css) drives the inner-div from rotateY(180°) → rotateY(0°).
 *
 * The front face is rendered in the normal flow so the container naturally
 * matches the card's dimensions.  The back face is absolutely positioned
 * to sit exactly on top without doubling the layout size.
 */

import PlayingCard from './PlayingCard';
import type { CardId } from '@/types/game';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CardFlipWrapperProps {
  /** The card that has just arrived in the player's hand. */
  cardId: CardId;
  /** Forward selected state to the face-up card (optional). */
  selected?: boolean;
  /** Forward disabled state to the face-up card (optional). */
  disabled?: boolean;
  /** Forward click handler to the face-up card (optional). */
  onClick?: () => void;
  /** Card size — forwarded to both face and back PlayingCard instances. */
  size?: 'sm' | 'md' | 'lg';
  /** Extra className applied to the perspective-container wrapper. */
  className?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CardFlipWrapper({
  cardId,
  selected = false,
  disabled = false,
  onClick,
  size = 'md',
  className = '',
}: CardFlipWrapperProps) {
  return (
    /*
     * Perspective container — gives depth to child 3-D transforms.
     * 600 px is a comfortable perspective distance for a card-sized element.
     */
    <div
      style={{ perspective: '600px' }}
      className={className}
      data-testid="card-flip-wrapper"
    >
      {/*
       * Inner flip-div — carries transform-style:preserve-3d so that both
       * child faces share the same 3-D space.
       *
       * The `.animate-card-flip-reveal` class (globals.css) animates it from
       * rotateY(180°) to rotateY(0°) over 550 ms.
       */}
      <div
        className="relative animate-card-flip-reveal"
        data-testid="card-flip-inner"
      >
        {/* ── Front face (face-up) — visible at the end of the animation ── */}
        <div
          style={{
            backfaceVisibility: 'hidden',
            WebkitBackfaceVisibility: 'hidden',
          }}
          data-testid="card-flip-front"
        >
          <PlayingCard
            cardId={cardId}
            faceDown={false}
            selected={selected}
            disabled={disabled}
            onClick={onClick}
            size={size}
          />
        </div>

        {/* ── Back face (face-down) — visible at the start of the animation ── */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backfaceVisibility: 'hidden',
            WebkitBackfaceVisibility: 'hidden',
            transform: 'rotateY(180deg)',
          }}
          aria-hidden="true"
          data-testid="card-flip-back"
        >
          <PlayingCard
            cardId={cardId}
            faceDown={true}
            size={size}
          />
        </div>
      </div>
    </div>
  );
}
