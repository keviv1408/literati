'use client';

/**
 * CardHand — renders the local player's hand.
 *
 * Layout is responsive:
 *   • Desktop (sm+): clean sorted row/spread grouped by suit via DesktopCardHand.
 *   • Mobile (<sm):  fan/arc layout with horizontal scroll via MobileCardHand.
 *
 * Tapping/clicking a card selects it (used for ask flow).
 */

import DesktopCardHand from './DesktopCardHand';
import MobileCardHand from './MobileCardHand';
import type { CardId } from '@/types/game';

interface CardHandProps {
  hand: CardId[];
  selectedCard?: CardId | null;
  onSelectCard?: (cardId: CardId) => void;
  isMyTurn: boolean;
  /** When true, show face-down placeholders (e.g. during a transition) */
  faceDown?: boolean;
  /** Disable all card interactions */
  disabled?: boolean;
  /**
   * Card-removal variant — forwarded to both DesktopCardHand (Low/High
   * half-suit boundary notch) and MobileCardHand (half-suit sort grouping).
   */
  variant?: 'remove_2s' | 'remove_7s' | 'remove_8s';
  /**
   * The card ID that just arrived in this player's hand after a successful
   * ask.  When set, DesktopCardHand and MobileCardHand will render that card
   * with a CardFlipWrapper (back → face flip animation) instead of a plain
   * PlayingCard.  Cleared by the parent after the animation duration (~700 ms).
   */
  newlyArrivedCardId?: CardId | null;
}

export default function CardHand({
  hand,
  selectedCard = null,
  onSelectCard,
  isMyTurn,
  faceDown = false,
  disabled = false,
  variant,
  newlyArrivedCardId = null,
}: CardHandProps) {
  if (hand.length === 0) {
    return (
      <div
        className="flex items-center justify-center h-16 text-xs text-slate-500"
        data-testid="card-hand-empty"
      >
        No cards — waiting for the next declaration…
      </div>
    );
  }

  return (
    <div
      className="relative flex flex-col w-full"
      aria-label={`Your hand: ${hand.length} card${hand.length !== 1 ? 's' : ''}`}
      data-testid="card-hand"
    >
      {/* ── Desktop: clean sorted row/spread layout (hidden on mobile) ── */}
      <DesktopCardHand
        hand={hand}
        selectedCard={selectedCard}
        onSelectCard={onSelectCard}
        isMyTurn={isMyTurn}
        faceDown={faceDown}
        disabled={disabled}
        variant={variant}
        newlyArrivedCardId={newlyArrivedCardId}
      />

      {/* ── Mobile: arc fan + horizontal-scroll layout (hidden on sm+) ── */}
      <div className="sm:hidden">
        <MobileCardHand
          hand={hand}
          selectedCard={selectedCard}
          onSelectCard={onSelectCard}
          isMyTurn={isMyTurn}
          faceDown={faceDown}
          disabled={disabled}
          variant={variant}
          newlyArrivedCardId={newlyArrivedCardId}
        />
      </div>
    </div>
  );
}
